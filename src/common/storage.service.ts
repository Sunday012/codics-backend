import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileCategory } from '@prisma/client';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertValidUploadFile,
  generateObjectKey,
  sanitizeFileName,
  StorageObjectCategory,
} from './file-validator.util';

export interface IStorageService {
  putObject(fileKey: string, buffer: Buffer, mimeType: string): Promise<string>;
  getObject(fileKey: string): Promise<Buffer>;
  deleteObject(fileKey: string): Promise<void>;
  objectExists?(fileKey: string): Promise<boolean>;
  getPresignedDownloadUrl?(
    fileKey: string,
    expiresInSeconds?: number,
    downloadFileName?: string,
  ): Promise<string | null>;
}

export interface IStorageAdapter extends IStorageService {
  readonly driverName: 'disk' | 's3';
  objectExists(fileKey: string): Promise<boolean>;
  getPresignedDownloadUrl(
    fileKey: string,
    expiresInSeconds: number,
    downloadFileName?: string,
  ): Promise<string | null>;
}

export interface CategorizedUploadOptions {
  category: FileCategory;
  subFolder?: string;
  originalName: string;
  buffer: Buffer;
  mimeType?: string;
  maxSizeBytes: number;
  allowedExtensions?: string[];
  uploaderId: string;
  linkedRecordId?: string;
}

export interface CategorizedUploadResult {
  fileKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storedFileId?: string;
}

const CATEGORY_TO_PREFIX: Record<FileCategory, StorageObjectCategory> = {
  [FileCategory.course_material]: 'course-materials',
  [FileCategory.assignment_submission]: 'submissions',
  [FileCategory.past_question]: 'past-questions',
  [FileCategory.onboarding_document]: 'onboarding-docs',
};

/**
 * Local Disk Storage Adapter (for development and testing).
 * Enforces path containment within uploadDir to prevent path traversal.
 */
export class DiskStorageAdapter implements IStorageAdapter {
  readonly driverName = 'disk' as const;
  private readonly logger = new Logger(DiskStorageAdapter.name);
  private readonly uploadDir: string;

  constructor(uploadDir: string) {
    this.uploadDir = resolve(process.cwd(), uploadDir);
  }

  private resolveSafePath(fileKey: string): string {
    const cleanKey = fileKey.replace(/^[/\\]+/, '');
    const resolved = resolve(this.uploadDir, cleanKey);
    const rootWithSep = this.uploadDir.endsWith(sep)
      ? this.uploadDir
      : `${this.uploadDir}${sep}`;
    if (resolved !== this.uploadDir && !resolved.startsWith(rootWithSep)) {
      throw new BadRequestException('Invalid storage object key path');
    }
    return resolved;
  }

  async putObject(
    fileKey: string,
    buffer: Buffer,
    _mimeType: string,
  ): Promise<string> {
    const fullPath = this.resolveSafePath(fileKey);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, buffer);
    this.logger.debug(
      `Saved object to local disk: ${fileKey} (${buffer.length} bytes)`,
    );
    return fileKey;
  }

  async getObject(fileKey: string): Promise<Buffer> {
    const fullPath = this.resolveSafePath(fileKey);
    try {
      return await readFile(fullPath);
    } catch {
      throw new NotFoundException(`File object not found: ${fileKey}`);
    }
  }

  async deleteObject(fileKey: string): Promise<void> {
    const fullPath = this.resolveSafePath(fileKey);
    try {
      await unlink(fullPath);
    } catch {
      this.logger.warn(`Could not delete local file: ${fileKey}`);
    }
  }

  async objectExists(fileKey: string): Promise<boolean> {
    const fullPath = this.resolveSafePath(fileKey);
    try {
      await access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async getPresignedDownloadUrl(
    _fileKey: string,
    _expiresInSeconds: number,
    _downloadFileName?: string,
  ): Promise<string | null> {
    // Disk adapter relies on authenticated backend streaming
    return null;
  }
}

export interface S3AdapterConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * S3-Compatible Object Storage Adapter (Cloudflare R2, AWS S3, MinIO, Backblaze B2).
 * Uses private bucket semantics with server-side streaming or short-lived presigned URLs.
 */
export class S3StorageAdapter implements IStorageAdapter {
  readonly driverName = 's3' as const;
  private readonly logger = new Logger(S3StorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3AdapterConfig, customClient?: S3Client) {
    this.bucket = cfg.bucket;
    this.client =
      customClient ||
      new S3Client({
        region: cfg.region || 'auto',
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle ?? true,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
      });
  }

  private validateKey(fileKey: string): string {
    const trimmed = (fileKey || '').trim().replace(/^\/+/, '');
    if (!trimmed || trimmed.includes('..') || trimmed.includes('\0')) {
      throw new BadRequestException('Invalid storage object key');
    }
    return trimmed;
  }

  async putObject(
    fileKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string> {
    const key = this.validateKey(fileKey);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType || 'application/octet-stream',
          CacheControl: 'private, no-transform',
        }),
      );
      this.logger.debug(
        `Uploaded object to S3 bucket "${this.bucket}": ${key} (${buffer.length} bytes)`,
      );
      return key;
    } catch (err: any) {
      this.logger.error(
        `Failed to upload object "${key}" to S3 storage: ${err?.message || 'Unknown error'}`,
      );
      throw new InternalServerErrorException(
        'Failed to store file in object storage',
      );
    }
  }

  async getObject(fileKey: string): Promise<Buffer> {
    const key = this.validateKey(fileKey);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) {
        throw new NotFoundException(`File object not found: ${key}`);
      }

      const byteArray = await response.Body.transformToByteArray();
      return Buffer.from(byteArray);
    } catch (err: any) {
      if (
        err instanceof NotFoundException ||
        err?.name === 'NoSuchKey' ||
        err?.name === 'NotFound' ||
        err?.$metadata?.httpStatusCode === 404
      ) {
        throw new NotFoundException(`File object not found: ${key}`);
      }
      this.logger.error(
        `Failed to retrieve object "${key}" from S3 storage: ${err?.message || 'Unknown error'}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve file from object storage',
      );
    }
  }

  async deleteObject(fileKey: string): Promise<void> {
    const key = this.validateKey(fileKey);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      this.logger.debug(`Deleted object from S3 bucket "${this.bucket}": ${key}`);
    } catch (err: any) {
      this.logger.warn(
        `Could not delete S3 object "${key}": ${err?.message || 'Unknown error'}`,
      );
    }
  }

  async objectExists(fileKey: string): Promise<boolean> {
    const key = this.validateKey(fileKey);
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async getPresignedDownloadUrl(
    fileKey: string,
    expiresInSeconds: number,
    downloadFileName?: string,
  ): Promise<string> {
    const key = this.validateKey(fileKey);
    const boundedTtl = Math.max(60, Math.min(expiresInSeconds || 900, 3600));
    const safeName = downloadFileName
      ? sanitizeFileName(downloadFileName)
      : undefined;

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(safeName
        ? {
            ResponseContentDisposition: `attachment; filename="${safeName}"`,
          }
        : {}),
    });

    return getSignedUrl(this.client, command, { expiresIn: boundedTtl });
  }
}

/**
 * StorageService provides a unified, provider-agnostic facade over S3-compatible
 * object storage (Cloudflare R2, AWS S3, MinIO) and local disk fallback.
 *
 * Also manages file signature verification, unpredictable key generation,
 * PostgreSQL StoredFile metadata tracking, and safe rollback cleanup.
 */
@Injectable()
export class StorageService implements IStorageService {
  private readonly logger = new Logger(StorageService.name);
  private adapter: IStorageAdapter;
  private readonly defaultUrlExpirySeconds: number;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    const driver = (
      config.get<string>('STORAGE_DRIVER', 'disk') || 'disk'
    ).toLowerCase();
    this.defaultUrlExpirySeconds = Number(
      config.get<string | number>('STORAGE_URL_EXPIRY_SECONDS', 900),
    );

    if (driver === 's3' || driver === 'r2') {
      const endpoint = config.get<string>('STORAGE_ENDPOINT', '');
      const region = config.get<string>('STORAGE_REGION', 'auto');
      const bucket = config.get<string>('STORAGE_BUCKET', '');
      const accessKeyId = config.get<string>('STORAGE_ACCESS_KEY_ID', '');
      const secretAccessKey = config.get<string>(
        'STORAGE_SECRET_ACCESS_KEY',
        '',
      );
      const forcePathStyle =
        String(config.get<string>('STORAGE_FORCE_PATH_STYLE', 'true')) !==
        'false';

      this.adapter = new S3StorageAdapter({
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle,
      });
      this.logger.log(
        `StorageService initialized with S3-compatible adapter (bucket: ${bucket}, region: ${region})`,
      );
    } else {
      const uploadDir = config.get<string>('UPLOAD_DIR', './uploads');
      this.adapter = new DiskStorageAdapter(uploadDir);
      this.logger.log(
        `StorageService initialized with local disk adapter (dir: ${uploadDir})`,
      );
    }
  }

  /**
   * Allows tests or custom runtime setups to swap the underlying storage adapter.
   */
  setAdapter(adapter: IStorageAdapter): void {
    this.adapter = adapter;
  }

  getDriverName(): 'disk' | 's3' {
    return this.adapter.driverName;
  }

  async putObject(
    fileKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string> {
    return this.adapter.putObject(fileKey, buffer, mimeType);
  }

  async getObject(fileKey: string): Promise<Buffer> {
    return this.adapter.getObject(fileKey);
  }

  async deleteObject(fileKey: string): Promise<void> {
    await this.adapter.deleteObject(fileKey);
  }

  async objectExists(fileKey: string): Promise<boolean> {
    return this.adapter.objectExists(fileKey);
  }

  async getPresignedDownloadUrl(
    fileKey: string,
    expiresInSeconds?: number,
    downloadFileName?: string,
  ): Promise<string | null> {
    return this.adapter.getPresignedDownloadUrl(
      fileKey,
      expiresInSeconds ?? this.defaultUrlExpirySeconds,
      downloadFileName,
    );
  }

  /**
   * Validates file size, extension, and magic-byte signature, generates an
   * unpredictable server-side object key, uploads to the active storage adapter,
   * and records metadata in PostgreSQL (`StoredFile`).
   *
   * Automatically cleans up the uploaded object if metadata persistence fails.
   */
  async uploadCategorizedObject(
    options: CategorizedUploadOptions,
  ): Promise<CategorizedUploadResult> {
    const {
      category,
      subFolder,
      originalName,
      buffer,
      mimeType,
      maxSizeBytes,
      allowedExtensions,
      uploaderId,
      linkedRecordId,
    } = options;

    // 1. Validate size, extension, and magic bytes
    const sig = assertValidUploadFile({
      buffer,
      fileName: originalName,
      mimeType,
      maxSizeBytes,
      allowedExtensions,
    });

    const safeFileName = sanitizeFileName(originalName);
    const prefix = CATEGORY_TO_PREFIX[category] || 'course-materials';
    const fileKey = generateObjectKey(prefix, safeFileName, subFolder);
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    // 2. Upload to storage adapter
    await this.adapter.putObject(fileKey, buffer, sig.detectedMimeType);

    // 3. Record metadata in PostgreSQL (if Prisma is available)
    let storedFileId: string | undefined;
    if (this.prisma && (this.prisma as any).storedFile) {
      try {
        const record = await this.prisma.storedFile.create({
          data: {
            fileKey,
            fileName: safeFileName,
            mimeType: sig.detectedMimeType,
            sizeBytes: buffer.length,
            sha256,
            category,
            uploaderId,
            linkedRecordId: linkedRecordId || null,
            storageDriver: this.adapter.driverName,
          },
        });
        storedFileId = record.id;
      } catch (dbErr) {
        // Rollback uploaded file so no orphan remains in storage
        await this.adapter.deleteObject(fileKey);
        throw dbErr;
      }
    }

    return {
      fileKey,
      fileName: safeFileName,
      mimeType: sig.detectedMimeType,
      sizeBytes: buffer.length,
      sha256,
      storedFileId,
    };
  }

  /**
   * Updates the linkedRecordId of a StoredFile record after the parent domain
   * entity is created inside a transaction.
   */
  async linkStoredFileRecord(
    fileKey: string,
    linkedRecordId: string,
  ): Promise<void> {
    if (!this.prisma || !(this.prisma as any).storedFile) return;
    try {
      await this.prisma.storedFile.updateMany({
        where: { fileKey },
        data: { linkedRecordId },
      });
    } catch (err: any) {
      this.logger.warn(
        `Could not link StoredFile "${fileKey}" to record "${linkedRecordId}": ${err?.message}`,
      );
    }
  }

  /**
   * Deletes an object from storage and removes its StoredFile metadata entry.
   */
  async deleteCategorizedObject(fileKey: string): Promise<void> {
    if (!fileKey) return;
    await this.adapter.deleteObject(fileKey);
    if (this.prisma && (this.prisma as any).storedFile) {
      try {
        await this.prisma.storedFile.deleteMany({
          where: { fileKey },
        });
      } catch (err: any) {
        this.logger.warn(
          `Could not remove StoredFile metadata for "${fileKey}": ${err?.message}`,
        );
      }
    }
  }
}
