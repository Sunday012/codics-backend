import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileCategory, MaterialStatus, Role } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidUploadFile,
  generateObjectKey,
  sanitizeFileName,
  verifyFileSignature,
} from './file-validator.util';
import {
  DiskStorageAdapter,
  S3StorageAdapter,
  StorageService,
} from './storage.service';
import { CoursesService } from '../domain/courses.service';
import { AssignmentsService } from '../domain/assignments.service';
import { PastQuestionsService } from '../domain/past-questions.service';

// Mock @aws-sdk/s3-request-presigner so S3 presigned URL tests work deterministically offline
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(
    async (_client: any, command: any, opts: { expiresIn: number }) =>
      `https://s3.mock-provider.local/${command.input.Bucket}/${command.input.Key}?X-Amz-Expires=${opts.expiresIn}`,
  ),
}));

describe('Phase 5 — S3-Compatible Object Storage & File Security', () => {
  describe('File Signature & Object Key Utilities (file-validator.util)', () => {
    it('sanitizes dangerous client filenames and strips path traversal segments', () => {
      expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
      expect(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe')).toBe(
        'cmd.exe',
      );
      expect(sanitizeFileName('CSC 301: Week 1 (Notes)!.pdf')).toBe(
        'CSC_301_Week_1_Notes_.pdf',
      );
    });

    it('generates unpredictable server-side object keys scoped by category and subFolder', () => {
      const key1 = generateObjectKey(
        'submissions',
        'solution.pdf',
        'asg-1/usr-1',
      );
      const key2 = generateObjectKey(
        'submissions',
        'solution.pdf',
        'asg-1/usr-1',
      );

      expect(key1).toMatch(
        /^submissions\/asg-1\/usr-1\/[0-9a-f-]{36}-solution\.pdf$/,
      );
      expect(key1).not.toEqual(key2);
    });

    it('verifies valid PDF, PNG, JPEG, and ZIP/OOXML magic-byte signatures', () => {
      const pdfBuf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj');
      expect(verifyFileSignature(pdfBuf, 'lecture.pdf')).toEqual({
        valid: true,
        detectedMimeType: 'application/pdf',
        extension: '.pdf',
      });

      const pngBuf = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
      ]);
      expect(verifyFileSignature(pngBuf, 'diagram.png')).toEqual({
        valid: true,
        detectedMimeType: 'image/png',
        extension: '.png',
      });

      const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(verifyFileSignature(jpgBuf, 'scan.jpg')).toEqual({
        valid: true,
        detectedMimeType: 'image/jpeg',
        extension: '.jpg',
      });

      const zipBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
      expect(verifyFileSignature(zipBuf, 'slides.pptx')).toEqual({
        valid: true,
        detectedMimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: '.pptx',
      });
    });

    it('rejects spoofed Windows PE (.exe) or ELF binaries disguised as .pdf or .txt', () => {
      //MZ header (0x4D 0x5A) disguised as a PDF
      const peBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
      const resPdf = verifyFileSignature(peBuffer, 'assignment.pdf');
      expect(resPdf.valid).toBe(false);
      expect(resPdf.reason).toMatch(/Executable binaries/);

      // ELF header (0x7F 'E' 'L' 'F') disguised as a text file
      const elfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
      const resTxt = verifyFileSignature(elfBuffer, 'notes.txt');
      expect(resTxt.valid).toBe(false);
      expect(resTxt.reason).toMatch(/Executable binaries/);
    });

    it('rejects files whose magic bytes do not match their claimed extension', () => {
      const randomBytes = Buffer.from('Just plain text pretending to be PDF');
      expect(() =>
        assertValidUploadFile({
          buffer: randomBytes,
          fileName: 'fake.pdf',
          mimeType: 'application/pdf',
          maxSizeBytes: 5 * 1024 * 1024,
          allowedExtensions: ['.pdf'],
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('DiskStorageAdapter', () => {
    let tempDir: string;
    let adapter: DiskStorageAdapter;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'codics-storage-test-'));
      adapter = new DiskStorageAdapter(tempDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('stores, checks existence, reads, and deletes files on local disk', async () => {
      const key = 'course-materials/off-1/2026-10/test-doc.pdf';
      const payload = Buffer.from('%PDF-1.4 Test Disk Content');

      await adapter.putObject(key, payload, 'application/pdf');
      expect(await adapter.objectExists(key)).toBe(true);

      const retrieved = await adapter.getObject(key);
      expect(retrieved.equals(payload)).toBe(true);

      await adapter.deleteObject(key);
      expect(await adapter.objectExists(key)).toBe(false);
    });

    it('blocks path traversal attempts outside uploadDir', async () => {
      await expect(
        adapter.putObject(
          '../../outside-secret.txt',
          Buffer.from('bad'),
          'text/plain',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('S3StorageAdapter', () => {
    let mockS3Client: { send: jest.Mock };
    let s3Adapter: S3StorageAdapter;

    beforeEach(() => {
      mockS3Client = { send: jest.fn() };
      s3Adapter = new S3StorageAdapter(
        {
          endpoint: 'https://account.r2.cloudflarestorage.com',
          region: 'auto',
          bucket: 'codics-private-bucket',
          accessKeyId: 'test-access-key',
          secretAccessKey: 'test-secret-key',
          forcePathStyle: true,
        },
        mockS3Client as any,
      );
    });

    it('uploads, downloads, checks existence, generates presigned URLs, and deletes objects via S3 commands', async () => {
      mockS3Client.send.mockResolvedValueOnce({}); // PutObjectCommand
      const key = 'past-questions/CSC301/2026-10/exam.pdf';
      const body = Buffer.from('%PDF-1.5 S3 Content');

      const savedKey = await s3Adapter.putObject(key, body, 'application/pdf');
      expect(savedKey).toBe(key);
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);

      // GetObjectCommand
      mockS3Client.send.mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => new Uint8Array(body),
        },
      });
      const downloaded = await s3Adapter.getObject(key);
      expect(downloaded.equals(body)).toBe(true);

      // HeadObjectCommand
      mockS3Client.send.mockResolvedValueOnce({});
      expect(await s3Adapter.objectExists(key)).toBe(true);

      // Presigned URL generation
      const signedUrl = await s3Adapter.getPresignedDownloadUrl(
        key,
        600,
        'CSC301_Exam.pdf',
      );
      expect(signedUrl).toContain('codics-private-bucket');
      expect(signedUrl).toContain('X-Amz-Expires=600');

      // DeleteObjectCommand
      mockS3Client.send.mockResolvedValueOnce({});
      await s3Adapter.deleteObject(key);
      expect(mockS3Client.send).toHaveBeenCalledTimes(4);
    });

    it('translates S3 NoSuchKey / 404 responses into NestJS NotFoundException', async () => {
      const notFoundErr: any = new Error('NoSuchKey');
      notFoundErr.name = 'NoSuchKey';
      mockS3Client.send.mockRejectedValueOnce(notFoundErr);

      await expect(
        s3Adapter.getObject('submissions/missing.pdf'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('StorageService Metadata Tracking & Rollback Cleanup', () => {
    it('deletes the uploaded storage object if PostgreSQL StoredFile creation fails', async () => {
      const mockConfig = {
        get: jest.fn((k: string, def?: any) => def),
      } as unknown as ConfigService;

      const mockPrisma: any = {
        storedFile: {
          create: jest
            .fn()
            .mockRejectedValue(new Error('Simulated DB Constraint Error')),
        },
      };

      const service = new StorageService(mockConfig, mockPrisma);
      const mockAdapter = {
        driverName: 's3' as const,
        putObject: jest.fn().mockResolvedValue('key'),
        getObject: jest.fn(),
        deleteObject: jest.fn().mockResolvedValue(undefined),
        objectExists: jest.fn(),
        getPresignedDownloadUrl: jest.fn(),
      };
      service.setAdapter(mockAdapter);

      await expect(
        service.uploadCategorizedObject({
          category: FileCategory.course_material,
          subFolder: 'off-csc301',
          originalName: 'week1.pdf',
          buffer: Buffer.from('%PDF-1.4 valid pdf'),
          mimeType: 'application/pdf',
          maxSizeBytes: 10 * 1024 * 1024,
          uploaderId: 'lec-1',
        }),
      ).rejects.toThrow('Simulated DB Constraint Error');

      // Verify the uploaded file was cleaned up from object storage
      expect(mockAdapter.putObject).toHaveBeenCalledTimes(1);
      expect(mockAdapter.deleteObject).toHaveBeenCalledTimes(1);
    });
  });

  describe('Domain Integration: Course Materials, Submissions, and Past Questions', () => {
    it('extracts data-URI course materials into object storage without storing binaries in Material.body and enforces enrollment on download', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 Course Slide Deck');
      const dataUri = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;

      const mockPrisma: any = {
        module: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'mod-1',
            offeringId: 'off-1',
            deletedAt: null,
          }),
        },
        offeringLecturer: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ offeringId: 'off-1', userId: 'lec-1' }),
        },
        material: {
          create: jest.fn(({ data }) =>
            Promise.resolve({
              id: 'mat-1',
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          ),
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        enrollment: {
          findUnique: jest.fn(),
        },
      };

      const mockAudit: any = { log: jest.fn().mockResolvedValue(undefined) };
      const mockStorage: any = {
        uploadCategorizedObject: jest.fn().mockResolvedValue({
          fileKey: 'course-materials/off-1/2026-10/uuid-week1.pdf',
          fileName: 'Week_1_Slides.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdfBuffer.length,
          sha256: 'abc123sha',
        }),
        linkStoredFileRecord: jest.fn().mockResolvedValue(undefined),
        deleteCategorizedObject: jest.fn().mockResolvedValue(undefined),
        getObject: jest.fn().mockResolvedValue(pdfBuffer),
        getPresignedDownloadUrl: jest
          .fn()
          .mockResolvedValue('https://r2.signed/url'),
      };

      const coursesService = new CoursesService(
        mockPrisma,
        mockAudit,
        mockStorage,
      );

      const created = await coursesService.createMaterial(
        'mod-1',
        { id: 'lec-1', fullName: 'Dr. Lec', role: Role.lecturer },
        {
          title: 'Week 1 Slides',
          type: 'pdf',
          contentOrUrl: dataUri,
          status: 'published',
        },
      );

      // Verify binary data URI was NOT stored in PostgreSQL Material.body
      expect(mockPrisma.material.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fileKey: 'course-materials/off-1/2026-10/uuid-week1.pdf',
            body: undefined,
          }),
        }),
      );
      expect(created.contentOrUrl).toBe('/api/v1/materials/mat-1/download');

      // Verify unenrolled student is blocked from downloading material even with valid ID
      mockPrisma.material.findUnique.mockResolvedValue({
        id: 'mat-1',
        offeringId: 'off-1',
        title: 'Week 1 Slides',
        status: MaterialStatus.published,
        fileKey: 'course-materials/off-1/2026-10/uuid-week1.pdf',
        fileName: 'Week_1_Slides.pdf',
        sizeBytes: pdfBuffer.length,
        deletedAt: null,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        coursesService.getMaterialFile('mat-1', {
          id: 'student-unenrolled',
          role: Role.student,
        }),
      ).rejects.toThrow(ForbiddenException);

      // Verify enrolled student can download material
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        id: 'enr-1',
        offeringId: 'off-1',
        userId: 'student-enrolled',
      });

      const downloaded = await coursesService.getMaterialFile('mat-1', {
        id: 'student-enrolled',
        role: Role.student,
      });
      expect(downloaded.buffer.equals(pdfBuffer)).toBe(true);
      expect(downloaded.presignedUrl).toBe('https://r2.signed/url');
    });

    it('cleans up uploaded submission object if the database transaction fails', async () => {
      const mockPrisma: any = {
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            offeringId: 'off-1',
            deadline: new Date(Date.now() + 86400000),
            allowLate: true,
            allowedTypes: ['.pdf'],
            maxSizeBytes: 10 * 1024 * 1024,
            offering: { course: { code: 'CSC 301' } },
          }),
        },
        enrollment: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'enr-1', userId: 'stu-1' }),
        },
        $transaction: jest
          .fn()
          .mockRejectedValue(new Error('DB Transaction Deadlock')),
      };

      const mockStorage: any = {
        putObject: jest.fn().mockResolvedValue('submissions/key.pdf'),
        deleteObject: jest.fn().mockResolvedValue(undefined),
      };
      const mockAudit: any = { log: jest.fn() };
      const mockAuth: any = { effectiveRole: jest.fn(() => Role.student) };

      const assignmentsService = new AssignmentsService(
        mockPrisma,
        mockAudit,
        mockStorage,
        mockAuth,
      );

      const validPdfFile: any = {
        originalname: 'solution.pdf',
        mimetype: 'application/pdf',
        size: 32,
        buffer: Buffer.from('%PDF-1.4 Student Submission File'),
      };

      await expect(
        assignmentsService.submit(
          'asg-1',
          { id: 'stu-1', role: Role.student } as any,
          validPdfFile,
        ),
      ).rejects.toThrow('DB Transaction Deadlock');

      expect(mockStorage.putObject).toHaveBeenCalledTimes(1);
      expect(mockStorage.deleteObject).toHaveBeenCalledTimes(1);
    });

    it('deletes underlying storage object when a past question is removed', async () => {
      const mockPrisma: any = {
        pastQuestion: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pq-1',
            courseCode: 'CSC 301',
            uploaderId: 'lec-1',
            fileKey: 'past-questions/CSC301/2026-10/uuid-paper.pdf',
            deletedAt: null,
          }),
          update: jest.fn().mockResolvedValue({ id: 'pq-1' }),
        },
      };
      const mockStorage: any = {
        deleteCategorizedObject: jest.fn().mockResolvedValue(undefined),
      };
      const mockAudit: any = { log: jest.fn().mockResolvedValue(undefined) };
      const mockAuth: any = { effectiveRole: jest.fn(() => Role.lecturer) };

      const pastQuestionsService = new PastQuestionsService(
        mockPrisma,
        mockAudit,
        mockStorage,
        mockAuth,
      );

      await pastQuestionsService.remove('pq-1', {
        id: 'lec-1',
        role: Role.lecturer,
      } as any);

      expect(mockStorage.deleteCategorizedObject).toHaveBeenCalledWith(
        'past-questions/CSC301/2026-10/uuid-paper.pdf',
      );
    });
  });
});
