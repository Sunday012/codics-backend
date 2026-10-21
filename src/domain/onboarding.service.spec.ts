import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  DocReviewStatus,
  OnboardingDocType,
  OnboardingStatus,
  Role,
  UserStatus,
} from '@prisma/client';
import { OnboardingService, MANDATORY_ONBOARDING_DOCS } from './onboarding.service';

describe('OnboardingService (Phase 9 — Guided New-Student Onboarding)', () => {
  let service: OnboardingService;
  let mockPrisma: any;
  let mockStorage: any;
  let mockMail: any;
  let mockJwt: any;
  let mockConfig: any;

  const mockAdminUser: any = {
    id: 'usr-admin-1',
    fullName: 'Dr. Faculty Admin',
    role: Role.admin,
    departmentId: null,
  };

  const mockHodOther: any = {
    id: 'usr-hod-other',
    fullName: 'Prof. Other Head',
    role: Role.hod,
    departmentId: 'dept-cyber',
  };

  const mockDepartmentCs = {
    id: 'dept-cs',
    code: 'CSC',
    name: 'Computer Science',
  };

  beforeEach(() => {
    mockPrisma = {
      department: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => {
          if (where.id === 'dept-cs') return Promise.resolve(mockDepartmentCs);
          return Promise.resolve(null);
        }),
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where?.id === 'dept-cs') return Promise.resolve(mockDepartmentCs);
          if (where?.OR?.some((cond: any) => cond.id === 'dept-cs' || cond.code?.equals === 'CSC')) {
            return Promise.resolve(mockDepartmentCs);
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([mockDepartmentCs]),
      },
      onboardingApplication: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      onboardingDocument: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      onboardingReviewLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      registrationGuide: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(mockPrisma)),
    };

    mockStorage = {
      putObject: jest.fn().mockResolvedValue('stored-key'),
      getObject: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    mockMail = {
      sendAccountApprovedNotification: jest.fn().mockResolvedValue({ status: 'sent' }),
    };

    mockJwt = {
      sign: jest.fn().mockReturnValue('mock-candidate-jwt'),
      verify: jest.fn().mockReturnValue({ sub: 'app-1', type: 'onboarding_candidate' }),
    };

    mockConfig = {
      getOrThrow: jest.fn().mockReturnValue('test-jwt-secret-min-32-characters'),
    };

    service = new OnboardingService(
      mockPrisma,
      mockStorage,
      mockMail,
      mockJwt,
      mockConfig,
    );
  });

  describe('1. Application Initiation & Duplicate Prevention', () => {
    it('creates an application in draft status with normalized JAMB reg and tracking code', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce(null); // No duplicate
      mockPrisma.onboardingApplication.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'app-1',
          ...data,
          department: mockDepartmentCs,
          createdAt: new Date(),
        }),
      );

      const res = await service.createApplication({
        jambRegNo: ' 202612345678ab ',
        fullName: 'Chukwuma David Okafor',
        email: ' Chukwuma@gmail.com ',
        departmentId: 'dept-cs',
        session: '2025/2026',
        entryLevel: 100,
      });

      expect(res.application.jambRegNo).toBe('202612345678AB');
      expect(res.application.email).toBe('chukwuma@gmail.com');
      expect(res.application.status).toBe(OnboardingStatus.draft);
      expect(res.application.applicationNumber).toMatch(/^APP-2025-[A-F0-9]{6}$/);
      expect(res.accessToken).toBeDefined();
      expect(res.candidateToken).toBe('mock-candidate-jwt');
    });

    it('rejects duplicate applications for the same candidate and session', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'existing-app-1',
        applicationNumber: 'APP-2025-ABCD12',
        jambRegNo: '202612345678AB',
        session: '2025/2026',
      });

      await expect(
        service.createApplication({
          jambRegNo: '202612345678AB',
          fullName: 'Chukwuma David Okafor',
          email: 'chukwuma@gmail.com',
          departmentId: 'dept-cs',
          session: '2025/2026',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects application if selected department does not exist', async () => {
      await expect(
        service.createApplication({
          jambRegNo: '202699999999ZZ',
          fullName: 'Test Candidate',
          email: 'test@candidate.com',
          departmentId: 'dept-non-existent',
          session: '2025/2026',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('2. Document Upload Security & Validation', () => {
    it('accepts valid PDF documents and stores them in private storage', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.draft,
      });
      mockPrisma.onboardingDocument.findUnique.mockResolvedValueOnce(null);
      mockPrisma.onboardingDocument.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'doc-1', ...data, updatedAt: new Date() }),
      );

      const fakePdfBuffer = Buffer.from('%PDF-1.4\n%synthetic test document content');
      const fakeFile: any = {
        originalname: 'jamb-slip.pdf',
        mimetype: 'application/pdf',
        buffer: fakePdfBuffer,
      };

      const result = await service.uploadDocument(
        'app-1',
        OnboardingDocType.jamb_result,
        fakeFile,
      );

      expect(result.id).toBe('doc-1');
      expect(result.documentType).toBe(OnboardingDocType.jamb_result);
      expect(result.status).toBe(DocReviewStatus.pending);
      expect(mockStorage.putObject).toHaveBeenCalled();
    });

    it('rejects disguised executable files', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.draft,
      });

      // Windows MZ executable magic bytes
      const maliciousBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
      const fakeFile: any = {
        originalname: 'exploit.pdf',
        mimetype: 'application/pdf',
        buffer: maliciousBuffer,
      };

      await expect(
        service.uploadDocument('app-1', OnboardingDocType.o_level, fakeFile),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects uploads once application is already verified or matriculated', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.verified,
      });

      const fakeFile: any = {
        originalname: 'test.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
      };

      await expect(
        service.uploadDocument('app-1', OnboardingDocType.o_level, fakeFile),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('3. Application Submission & Missing Document Enforcement', () => {
    it('rejects submission if mandatory documents are missing', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.draft,
        documents: [
          { documentType: OnboardingDocType.jamb_result },
          { documentType: OnboardingDocType.o_level },
          // Missing birth_certificate and lga_identification
        ],
      });

      await expect(service.submitApplication('app-1')).rejects.toThrow(
        /Missing required documents/i,
      );
    });

    it('submits application once all 4 core documents are present', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        applicationNumber: 'APP-2025-001',
        status: OnboardingStatus.draft,
        documents: MANDATORY_ONBOARDING_DOCS.map((docType) => ({ documentType: docType })),
      });
      mockPrisma.onboardingApplication.update.mockResolvedValueOnce({
        id: 'app-1',
        applicationNumber: 'APP-2025-001',
        status: OnboardingStatus.submitted,
      });

      const result = await service.submitApplication('app-1');
      expect(result.status).toBe(OnboardingStatus.submitted);
      expect(mockPrisma.onboardingReviewLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'SUBMITTED',
            fromStatus: OnboardingStatus.draft,
            toStatus: OnboardingStatus.submitted,
          }),
        }),
      );
    });
  });

  describe('4. Staff Decisions & State Machine Transitions', () => {
    it('allows staff to request additional information (transitions to action_required with reason)', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        fullName: 'Chukwuma David',
        email: 'chukwuma@gmail.com',
        applicationNumber: 'APP-2025-001',
        status: OnboardingStatus.submitted,
        documents: [],
      });
      mockPrisma.onboardingApplication.update.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.action_required,
      });

      const res = await service.reviewApplication(mockAdminUser, 'app-1', {
        action: 'REQUEST_INFO',
        reason: 'O-Level scratch card PIN is blurry. Please re-upload.',
      });

      expect(res.status).toBe(OnboardingStatus.action_required);
      expect(mockMail.sendAccountApprovedNotification).toHaveBeenCalled();
    });

    it('rejects VERIFY_APPLICATION if any mandatory document is not individually verified', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.submitted,
        documents: [
          { documentType: OnboardingDocType.jamb_result, status: DocReviewStatus.verified, title: 'JAMB' },
          { documentType: OnboardingDocType.o_level, status: DocReviewStatus.pending, title: 'O-Level' }, // Not verified!
          { documentType: OnboardingDocType.birth_certificate, status: DocReviewStatus.verified, title: 'Birth Cert' },
          { documentType: OnboardingDocType.lga_identification, status: DocReviewStatus.verified, title: 'LGA' },
        ],
      });

      await expect(
        service.reviewApplication(mockAdminUser, 'app-1', {
          action: 'VERIFY_APPLICATION',
        }),
      ).rejects.toThrow(/must be individually verified first/i);
    });

    it('approves application when all mandatory documents are verified', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        fullName: 'Chukwuma David',
        email: 'chukwuma@gmail.com',
        applicationNumber: 'APP-2025-001',
        status: OnboardingStatus.submitted,
        documents: MANDATORY_ONBOARDING_DOCS.map((docType) => ({
          documentType: docType,
          status: DocReviewStatus.verified,
          title: docType,
        })),
      });
      mockPrisma.onboardingApplication.update.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.verified,
      });

      const res = await service.reviewApplication(mockAdminUser, 'app-1', {
        action: 'VERIFY_APPLICATION',
      });

      expect(res.status).toBe(OnboardingStatus.verified);
    });

    it('prevents HOD from reviewing applications belonging to another department', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        departmentId: 'dept-cs',
        status: OnboardingStatus.submitted,
        documents: [],
      });

      // mockHodOther belongs to dept-cyber
      await expect(
        service.reviewApplication(mockHodOther, 'app-1', {
          action: 'REJECT',
          reason: 'Irrelevant reason',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('5. Transactional Identity & Matriculation Conversion', () => {
    it('rejects conversion if application is not in verified status', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.submitted, // Not verified!
      });

      await expect(
        service.convertApplicationToMatriculated(mockAdminUser, 'app-1', {
          matricNo: 'CSC/2026/042',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects conversion if target matriculation number is already assigned to an active student', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        status: OnboardingStatus.verified,
        convertedUserId: null,
      });
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: 'existing-stu',
        matricNo: 'CSC/2026/042',
        status: UserStatus.active, // Already active!
      });

      await expect(
        service.convertApplicationToMatriculated(mockAdminUser, 'app-1', {
          matricNo: 'CSC/2026/042',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('converts verified candidate into official invited student record on roster', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-1',
        applicationNumber: 'APP-2025-001',
        fullName: 'Chukwuma David Okafor',
        email: 'chukwuma@gmail.com',
        departmentId: 'dept-cs',
        entryLevel: 100,
        status: OnboardingStatus.verified,
        convertedUserId: null,
        department: mockDepartmentCs,
      });
      mockPrisma.user.findUnique.mockResolvedValueOnce(null); // No collision
      mockPrisma.user.create.mockResolvedValueOnce({
        id: 'new-stu-user-1',
        matricNo: 'CSC/2026/042',
        fullName: 'Chukwuma David Okafor',
        email: 'chukwuma@gmail.com',
        role: Role.student,
        status: UserStatus.invited,
        level: 100,
      });
      mockPrisma.onboardingApplication.update.mockResolvedValueOnce({
        id: 'app-1',
        applicationNumber: 'APP-2025-001',
        status: OnboardingStatus.matriculated,
        convertedMatricNo: 'CSC/2026/042',
      });

      const res = await service.convertApplicationToMatriculated(mockAdminUser, 'app-1', {
        matricNo: 'CSC/2026/042',
      });

      expect(res.status).toBe(OnboardingStatus.matriculated);
      expect(res.convertedStudent.matricNo).toBe('CSC/2026/042');
      expect(res.convertedStudent.status).toBe(UserStatus.invited);
      expect(res.activationInstructions).toContain('/activate');
    });
  });

  describe('6. Unauthorized Document Access Control', () => {
    it('blocks unauthorized callers from downloading candidate documents', async () => {
      mockPrisma.onboardingDocument.findUnique.mockResolvedValueOnce({
        id: 'doc-1',
        applicationId: 'app-1',
        fileName: 'confidential-waec.pdf',
        fileKey: 'onboarding-docs/app-1/doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });

      // Caller is student from a different account
      const unauthorizedCaller: any = {
        id: 'other-user',
        role: Role.student,
        applicationId: 'app-999',
      };

      await expect(
        service.streamDocument(unauthorizedCaller, 'doc-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows document owner candidate to access their own file', async () => {
      mockPrisma.onboardingDocument.findUnique.mockResolvedValueOnce({
        id: 'doc-1',
        applicationId: 'app-1',
        fileName: 'waec.pdf',
        fileKey: 'onboarding-docs/app-1/waec.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });

      const ownerCandidate: any = {
        applicationId: 'app-1',
      };

      const file = await service.streamDocument(ownerCandidate, 'doc-1');
      expect(file.fileName).toBe('waec.pdf');
      expect(mockStorage.getObject).toHaveBeenCalled();
    });

    it('allows staff with admin or hod role to access candidate document', async () => {
      mockPrisma.onboardingDocument.findUnique.mockResolvedValueOnce({
        id: 'doc-1',
        applicationId: 'app-1',
        fileName: 'waec.pdf',
        fileKey: 'onboarding-docs/app-1/waec.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });

      const file = await service.streamDocument(mockAdminUser, 'doc-1');
      expect(file.fileName).toBe('waec.pdf');
    });
  });

  describe('7. Verified Registration Guide (No Fake Payment Processing)', () => {
    it('returns official clearance and payment guide with warnings', async () => {
      const guide: any = await service.getRegistrationGuide('2025/2026', 'CSC');

      expect(guide.title).toBeDefined();
      const steps = guide.steps as any[];
      expect(steps.length).toBeGreaterThanOrEqual(4);
      expect(guide.importantNotice).toContain('CODICS is a guided workflow portal');
      expect(steps[0].officialPortalUrl).toContain('waeup.uniben.edu');
      expect(steps[0].warning).toContain('Never pay cash or transfer funds');
    });
  });
});
