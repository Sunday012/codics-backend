import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface IStorageService {
  putObject(fileKey: string, buffer: Buffer, mimeType: string): Promise<string>;
  getObject(fileKey: string): Promise<Buffer>;
  deleteObject(fileKey: string): Promise<void>;
}

/**
 * StorageService handles file persistence.
 * Current implementation uses a local disk driver storing files in a gitignored `uploads/` directory.
 * NOTE: Production driver will be Cloudflare R2 (S3-compatible API) with presigned URLs.
 */
@Injectable()
export class StorageService implements IStorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadDir: string;

  constructor(config: ConfigService) {
    this.uploadDir = resolve(process.cwd(), config.get<string>('UPLOAD_DIR', './uploads'));
  }

  private resolvePath(fileKey: string): string {
    return resolve(this.uploadDir, fileKey);
  }

  async putObject(fileKey: string, buffer: Buffer, _mimeType: string): Promise<string> {
    const fullPath = this.resolvePath(fileKey);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, buffer);
    this.logger.debug(`Saved object to local disk: ${fileKey} (${buffer.length} bytes)`);
    return fileKey;
  }

  async getObject(fileKey: string): Promise<Buffer> {
    const fullPath = this.resolvePath(fileKey);
    try {
      return await readFile(fullPath);
    } catch {
      throw new NotFoundException(`File object not found: ${fileKey}`);
    }
  }

  async deleteObject(fileKey: string): Promise<void> {
    const fullPath = this.resolvePath(fileKey);
    try {
      await unlink(fullPath);
    } catch {
      this.logger.warn(`Could not delete file: ${fileKey}`);
    }
  }
}
