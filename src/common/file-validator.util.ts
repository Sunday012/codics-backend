import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';

export type StorageObjectCategory =
  | 'course-materials'
  | 'submissions'
  | 'past-questions'
  | 'onboarding-docs';

export interface FileSignatureValidationResult {
  valid: boolean;
  detectedMimeType: string;
  extension: string;
  reason?: string;
}

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
  '.txt',
  '.md',
  '.csv',
  '.py',
  '.js',
  '.ts',
  '.c',
  '.cpp',
  '.java',
  '.sql',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.py',
  '.js',
  '.ts',
  '.c',
  '.cpp',
  '.java',
  '.sql',
]);

const OOXML_OR_ZIP_EXTENSIONS = new Set([
  '.zip',
  '.docx',
  '.pptx',
  '.xlsx',
]);

const OLE_EXTENSIONS = new Set(['.doc', '.ppt', '.xls']);

/**
 * Sanitizes a user-supplied filename, stripping any directory traversal
 * or unsafe characters.
 */
export function sanitizeFileName(originalName: string): string {
  const normalized = (originalName || 'document').replace(/\\/g, '/');
  const base = basename(normalized).replace(/\0/g, '');
  const sanitized = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '');
  return (sanitized || 'file').slice(0, 120);
}

/**
 * Generates an unpredictable server-side object key under a controlled prefix.
 * Never trusts client-supplied paths.
 */
export function generateObjectKey(
  category: StorageObjectCategory,
  originalName: string,
  subFolder?: string,
): string {
  const safeName = sanitizeFileName(originalName);
  const cleanSub = subFolder
    ? subFolder
        .split('/')
        .map((part) => part.replace(/[^a-zA-Z0-9_-]/g, ''))
        .filter(Boolean)
        .join('/') + '/'
    : '';
  return `${category}/${cleanSub}${randomUUID()}-${safeName}`;
}

/**
 * Checks if buffer starts with given byte sequence.
 */
function startsWithBytes(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Inspects file magic bytes and extension to prevent spoofed MIME headers
 * or disguised executables.
 */
export function verifyFileSignature(
  buffer: Buffer,
  fileName: string,
  declaredMimeType?: string,
): FileSignatureValidationResult {
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      detectedMimeType: 'application/octet-stream',
      extension: '',
      reason: 'File buffer is empty',
    };
  }

  const ext = extname(sanitizeFileName(fileName)).toLowerCase();
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      detectedMimeType: declaredMimeType || 'application/octet-stream',
      extension: ext,
      reason: `Unsupported file extension "${ext}"`,
    };
  }

  // Block Windows PE (MZ) and ELF executables immediately
  if (
    startsWithBytes(buffer, [0x4d, 0x5a]) || // MZ (EXE/DLL)
    startsWithBytes(buffer, [0x7f, 0x45, 0x4c, 0x46]) // \x7FELF
  ) {
    return {
      valid: false,
      detectedMimeType: 'application/x-msdownload',
      extension: ext,
      reason: 'Executable binaries are strictly prohibited',
    };
  }

  // 1. PDF check: %PDF (0x25 0x50 0x44 0x46)
  if (ext === '.pdf' || declaredMimeType === 'application/pdf') {
    if (!startsWithBytes(buffer, [0x25, 0x50, 0x44, 0x46])) {
      return {
        valid: false,
        detectedMimeType: 'application/octet-stream',
        extension: ext || '.pdf',
        reason: 'Invalid PDF file signature (missing %PDF magic header)',
      };
    }
    return {
      valid: true,
      detectedMimeType: 'application/pdf',
      extension: '.pdf',
    };
  }

  // 2. PNG check: 89 50 4E 47 0D 0A 1A 0A
  if (ext === '.png' || declaredMimeType === 'image/png') {
    if (
      !startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ) {
      return {
        valid: false,
        detectedMimeType: 'application/octet-stream',
        extension: ext || '.png',
        reason: 'Invalid PNG file signature',
      };
    }
    return {
      valid: true,
      detectedMimeType: 'image/png',
      extension: '.png',
    };
  }

  // 3. JPEG check: FF D8 FF
  if (ext === '.jpg' || ext === '.jpeg' || declaredMimeType === 'image/jpeg') {
    if (!startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
      return {
        valid: false,
        detectedMimeType: 'application/octet-stream',
        extension: ext || '.jpg',
        reason: 'Invalid JPEG file signature',
      };
    }
    return {
      valid: true,
      detectedMimeType: 'image/jpeg',
      extension: ext || '.jpg',
    };
  }

  // 4. ZIP / OOXML (.zip, .docx, .pptx, .xlsx): PK\x03\x04 or PK\x05\x06
  if (OOXML_OR_ZIP_EXTENSIONS.has(ext)) {
    const isPkZip =
      startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]);
    if (!isPkZip) {
      return {
        valid: false,
        detectedMimeType: 'application/octet-stream',
        extension: ext,
        reason: `Invalid archive/Office Open XML signature for ${ext}`,
      };
    }
    const mimeMap: Record<string, string> = {
      '.zip': 'application/zip',
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return {
      valid: true,
      detectedMimeType: mimeMap[ext] || declaredMimeType || 'application/zip',
      extension: ext,
    };
  }

  // 5. Legacy OLE2 Office (.doc, .ppt, .xls): D0 CF 11 E0
  if (OLE_EXTENSIONS.has(ext)) {
    if (!startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0])) {
      return {
        valid: false,
        detectedMimeType: 'application/octet-stream',
        extension: ext,
        reason: `Invalid OLE2 document signature for ${ext}`,
      };
    }
    return {
      valid: true,
      detectedMimeType: declaredMimeType || 'application/msword',
      extension: ext,
    };
  }

  // 6. Plain text / source code files
  if (TEXT_EXTENSIONS.has(ext) || declaredMimeType?.startsWith('text/')) {
    // Check first 4KB for NUL bytes indicating binary content disguised as text
    const sampleLength = Math.min(buffer.length, 4096);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0x00) {
        return {
          valid: false,
          detectedMimeType: 'application/octet-stream',
          extension: ext,
          reason: 'Binary content detected in plain-text/code upload',
        };
      }
    }
    return {
      valid: true,
      detectedMimeType: declaredMimeType || 'text/plain',
      extension: ext || '.txt',
    };
  }

  return {
    valid: true,
    detectedMimeType: declaredMimeType || 'application/octet-stream',
    extension: ext,
  };
}

/**
 * Throws BadRequestException if file fails size or signature checks.
 */
export function assertValidUploadFile(options: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  maxSizeBytes: number;
  allowedExtensions?: string[];
}): FileSignatureValidationResult {
  const { buffer, fileName, mimeType, maxSizeBytes, allowedExtensions } =
    options;

  if (!buffer || buffer.length === 0) {
    throw new BadRequestException('Uploaded file cannot be empty');
  }

  if (buffer.length > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    throw new BadRequestException(
      `File size (${buffer.length} bytes) exceeds maximum limit of ${maxMb} MB`,
    );
  }

  const ext = extname(sanitizeFileName(fileName)).toLowerCase();
  if (allowedExtensions && allowedExtensions.length > 0) {
    const normalizedAllowed = allowedExtensions.map((e) =>
      e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
    );
    if (!normalizedAllowed.includes(ext)) {
      throw new BadRequestException(
        `File type "${ext || 'unknown'}" is not allowed. Permitted types: ${normalizedAllowed.join(', ')}`,
      );
    }
  }

  const sig = verifyFileSignature(buffer, fileName, mimeType);
  if (!sig.valid) {
    throw new BadRequestException(sig.reason || 'Invalid file signature');
  }

  return sig;
}
