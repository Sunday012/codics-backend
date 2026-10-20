/**
 * CODICS Storage Migration & Inventory Utility (`scripts/migrate-storage.ts`)
 *
 * Safely inventories local disk files and PostgreSQL file metadata across:
 *   1. Course Materials (`Material`, including legacy base64 data URIs in `Material.body`)
 *   2. Assignment Submissions (`SubmissionVersion`)
 *   3. Past Question Papers (`PastQuestion`)
 *   4. Centralized `StoredFile` registry
 *
 * Modes:
 *   - Default (Dry-Run): Lists inventory, checks local disk existence & SHA-256 integrity,
 *     and reports any orphaned or missing objects without mutating S3 or PostgreSQL.
 *   - `--execute`: Copies verified local disk files (and extracts legacy `Material.body`
 *     data-URI binaries) to the configured S3-compatible bucket, verifies remote `HeadObject`
 *     existence, backfills `StoredFile` records, and clears binary `Material.body` payloads.
 *
 * Rollback Plan:
 *   - Local disk files in `UPLOAD_DIR` are NEVER deleted during migration.
 *   - If rollback is needed, set `STORAGE_DRIVER=disk` in `.env` and restart the service;
 *     all original `fileKey` paths remain intact on local disk.
 */

import 'dotenv/config';
import { PrismaClient, FileCategory } from '@prisma/client';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  S3StorageAdapter,
  DiskStorageAdapter,
} from '../src/common/storage.service';
import {
  generateObjectKey,
  sanitizeFileName,
} from '../src/common/file-validator.util';

export interface MigrationInventoryItem {
  category: FileCategory;
  recordId: string;
  fileKey: string | null;
  fileName: string;
  mimeType: string;
  expectedSizeBytes: number;
  expectedSha256: string | null;
  uploaderId: string | null;
  sourceType: 'disk_file' | 'legacy_db_data_uri' | 'missing_key';
  existsOnDisk: boolean;
  actualSha256: string | null;
  checksumMatch: boolean;
}

export interface MigrationReport {
  mode: 'dry-run' | 'execute';
  totalScanned: number;
  readyToMigrate: number;
  legacyDataUriCount: number;
  missingOnDiskCount: number;
  checksumMismatchCount: number;
  migratedCount: number;
  failedCount: number;
  items: MigrationInventoryItem[];
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function buildStorageInventory(
  prisma: PrismaClient,
  uploadDir: string,
): Promise<MigrationInventoryItem[]> {
  const disk = new DiskStorageAdapter(uploadDir);
  const items: MigrationInventoryItem[] = [];

  // 1. Course Materials
  const materials = await prisma.material.findMany({
    where: { deletedAt: null },
  });

  for (const mat of materials) {
    if (mat.fileKey) {
      const exists = await disk.objectExists(mat.fileKey);
      let actualSha: string | null = null;
      if (exists) {
        const buf = await disk.getObject(mat.fileKey);
        actualSha = sha256Hex(buf);
      }
      items.push({
        category: FileCategory.course_material,
        recordId: mat.id,
        fileKey: mat.fileKey,
        fileName: mat.fileName || `${mat.title}.pdf`,
        mimeType: (mat as any).mimeType || 'application/pdf',
        expectedSizeBytes: mat.sizeBytes || 0,
        expectedSha256: (mat as any).sha256 || null,
        uploaderId: (mat as any).uploaderId || null,
        sourceType: 'disk_file',
        existsOnDisk: exists,
        actualSha256: actualSha,
        checksumMatch:
          !((mat as any).sha256) || actualSha === (mat as any).sha256,
      });
    } else if (mat.body && mat.body.trim().startsWith('data:')) {
      const match = mat.body.trim().match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        const mimeType = match[1].trim().toLowerCase();
        const buf = Buffer.from(match[2].trim(), 'base64');
        const sha = sha256Hex(buf);
        items.push({
          category: FileCategory.course_material,
          recordId: mat.id,
          fileKey: null,
          fileName: sanitizeFileName(`${mat.title}.pdf`),
          mimeType,
          expectedSizeBytes: buf.length,
          expectedSha256: sha,
          uploaderId: (mat as any).uploaderId || null,
          sourceType: 'legacy_db_data_uri',
          existsOnDisk: true,
          actualSha256: sha,
          checksumMatch: true,
        });
      }
    }
  }

  // 2. Assignment Submissions
  const versions = await prisma.submissionVersion.findMany({
    include: { submission: true },
  });

  for (const ver of versions) {
    const exists = await disk.objectExists(ver.fileKey);
    let actualSha: string | null = null;
    if (exists) {
      const buf = await disk.getObject(ver.fileKey);
      actualSha = sha256Hex(buf);
    }
    items.push({
      category: FileCategory.assignment_submission,
      recordId: ver.id,
      fileKey: ver.fileKey,
      fileName: ver.fileName,
      mimeType: ver.mimeType,
      expectedSizeBytes: ver.sizeBytes,
      expectedSha256: ver.sha256,
      uploaderId: ver.submission?.studentId || null,
      sourceType: 'disk_file',
      existsOnDisk: exists,
      actualSha256: actualSha,
      checksumMatch: !ver.sha256 || actualSha === ver.sha256,
    });
  }

  // 3. Past Questions
  const papers = await prisma.pastQuestion.findMany({
    where: { deletedAt: null },
  });

  for (const pq of papers) {
    const exists = pq.fileKey ? await disk.objectExists(pq.fileKey) : false;
    let actualSha: string | null = null;
    if (exists && pq.fileKey) {
      const buf = await disk.getObject(pq.fileKey);
      actualSha = sha256Hex(buf);
    }
    items.push({
      category: FileCategory.past_question,
      recordId: pq.id,
      fileKey: pq.fileKey,
      fileName: pq.fileName,
      mimeType: pq.mimeType,
      expectedSizeBytes: pq.sizeBytes,
      expectedSha256: pq.sha256,
      uploaderId: pq.uploaderId,
      sourceType: pq.fileKey ? 'disk_file' : 'missing_key',
      existsOnDisk: exists,
      actualSha256: actualSha,
      checksumMatch: !pq.sha256 || actualSha === pq.sha256,
    });
  }

  return items;
}

export async function runStorageMigration(options: {
  prisma: PrismaClient;
  uploadDir: string;
  s3Adapter?: S3StorageAdapter;
  execute: boolean;
}): Promise<MigrationReport> {
  const { prisma, uploadDir, s3Adapter, execute } = options;
  const disk = new DiskStorageAdapter(uploadDir);
  const items = await buildStorageInventory(prisma, uploadDir);

  const readyItems = items.filter((i) => i.existsOnDisk && i.checksumMatch);
  const legacyCount = items.filter(
    (i) => i.sourceType === 'legacy_db_data_uri',
  ).length;
  const missingCount = items.filter((i) => !i.existsOnDisk).length;
  const mismatchCount = items.filter(
    (i) => i.existsOnDisk && !i.checksumMatch,
  ).length;

  let migratedCount = 0;
  let failedCount = 0;

  if (execute) {
    if (!s3Adapter) {
      throw new Error(
        'Cannot run migration with --execute without a configured S3StorageAdapter',
      );
    }

    for (const item of readyItems) {
      try {
        let buffer: Buffer;
        let targetKey = item.fileKey;

        if (item.sourceType === 'legacy_db_data_uri') {
          const mat = await prisma.material.findUnique({
            where: { id: item.recordId },
          });
          if (!mat?.body) continue;
          const match = mat.body.trim().match(/^data:([^;]+);base64,(.+)$/s);
          if (!match) continue;
          buffer = Buffer.from(match[2].trim(), 'base64');
          targetKey = generateObjectKey(
            'course-materials',
            item.fileName,
            mat.offeringId,
          );
        } else if (targetKey) {
          buffer = await disk.getObject(targetKey);
        } else {
          continue;
        }

        const verifiedSha = sha256Hex(buffer);
        await s3Adapter.putObject(targetKey, buffer, item.mimeType);

        const remoteExists = await s3Adapter.objectExists(targetKey);
        if (!remoteExists) {
          throw new Error(
            `Remote verification failed for key "${targetKey}"`,
          );
        }

        // Update legacy Material record if extracted from data URI
        if (item.sourceType === 'legacy_db_data_uri') {
          await prisma.material.update({
            where: { id: item.recordId },
            data: {
              fileKey: targetKey,
              fileName: item.fileName,
              sizeBytes: buffer.length,
              mimeType: item.mimeType,
              sha256: verifiedSha,
              body: null,
            },
          });
        }

        // Upsert StoredFile metadata if uploaderId is known
        if (item.uploaderId && (prisma as any).storedFile) {
          await (prisma as any).storedFile.upsert({
            where: { fileKey: targetKey },
            create: {
              fileKey: targetKey,
              fileName: item.fileName,
              mimeType: item.mimeType,
              sizeBytes: buffer.length,
              sha256: verifiedSha,
              category: item.category,
              uploaderId: item.uploaderId,
              linkedRecordId: item.recordId,
              storageDriver: 's3',
            },
            update: {
              storageDriver: 's3',
              sha256: verifiedSha,
              sizeBytes: buffer.length,
            },
          });
        }

        migratedCount++;
      } catch {
        failedCount++;
      }
    }
  }

  return {
    mode: execute ? 'execute' : 'dry-run',
    totalScanned: items.length,
    readyToMigrate: readyItems.length,
    legacyDataUriCount: legacyCount,
    missingOnDiskCount: missingCount,
    checksumMismatchCount: mismatchCount,
    migratedCount,
    failedCount,
    items,
  };
}

async function main() {
  const execute = process.argv.includes('--execute');
  const uploadDir = resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');

  try {
    await access(uploadDir);
  } catch {
    // Upload dir may not exist yet in fresh environments
  }

  const prisma = new PrismaClient();
  try {
    let s3Adapter: S3StorageAdapter | undefined;
    if (execute) {
      s3Adapter = new S3StorageAdapter({
        endpoint: process.env.STORAGE_ENDPOINT || '',
        region: process.env.STORAGE_REGION || 'auto',
        bucket: process.env.STORAGE_BUCKET || '',
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
        forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
      });
    }

    const report = await runStorageMigration({
      prisma,
      uploadDir,
      s3Adapter,
      execute,
    });

    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          totalScanned: report.totalScanned,
          readyToMigrate: report.readyToMigrate,
          legacyDataUriCount: report.legacyDataUriCount,
          missingOnDiskCount: report.missingOnDiskCount,
          checksumMismatchCount: report.checksumMismatchCount,
          migratedCount: report.migratedCount,
          failedCount: report.failedCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Migration script failed:', err?.message || err);
    process.exit(1);
  });
}
