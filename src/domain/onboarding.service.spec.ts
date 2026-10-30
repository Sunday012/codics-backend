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
          if (where?.id === 'dept-cs' || where?.code === 'CSC') return Promise.resolve(mockDepartmentCs);
          if (where?.OR?.some((cond: any) => cond.id === 'dept-cs' || cond.code === 'CSC' || cond.code?.equals === 'CSC')) {
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
      admissionsRoster: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      setting: {
        findFirst: jest.fn().mockResolvedValue({ session: '2026/2027', semester: 'first' }),
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

    const mockAuthService: any = {
      issueTokens: jest.fn().mockImplementation((u: any) => ({
        user: { id: u.id, fullName: u.fullName, email: u.email, role: u.role },
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      })),
    };

    service = new OnboardingService(
      mockPrisma,
      mockStorage,
      mockMail,
      mockJwt,
      mockConfig,
      mockAuthService,
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

    it('rejects candidate attempting to download document belonging to another application using candidate token', async () => {
      mockPrisma.onboardingDocument.findUnique.mockResolvedValueOnce({
        id: 'doc-confidential',
        applicationId: 'app-victim',
        fileName: 'confidential.pdf',
        fileKey: 'onboarding-docs/app-victim/confidential.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      });

      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-victim',
        accessKeyHash: 'some-hash',
      });

      // Attacker token is for app-attacker, not app-victim
      mockJwt.verify.mockReturnValueOnce({
        sub: 'app-attacker',
        type: 'onboarding_candidate',
      });

      await expect(
        service.streamDocument({ token: 'attacker-candidate-jwt' }, 'doc-confidential'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects candidate access when raw application ID is sent instead of valid cryptographic secret', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        id: 'app-target',
        accessKeyHash: (service as any).hashToken('correct-raw-token'),
      });

      // Attacker sends the application ID as the token
      mockJwt.verify.mockImplementationOnce(() => {
        throw new Error('invalid jwt');
      });

      await expect(
        service.validateCandidateAccess('app-target', 'app-target'),
      ).rejects.toThrow(ForbiddenException);
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

  describe('8. Phase 12.4: Admissions Roster Import, Student Matching & Exception Management', () => {
    describe('bulkImportAdmissionsRoster', () => {
      it('successfully imports valid records and validates department scoping for Admin', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValue(null);
        mockPrisma.admissionsRoster.create.mockResolvedValue({ id: 'adm-1' });

        const res = await service.bulkImportAdmissionsRoster(mockAdminUser, {
          records: [
            {
              jambRegNo: '202611112222AA',
              fullName: 'Aisha Bello',
              departmentCode: 'CSC',
              session: '2026/2027',
              level: 100,
            },
          ],
        });

        expect(res.total).toBe(1);
        expect(res.imported).toBe(1);
        expect(res.invalid).toBe(0);
        expect(mockPrisma.admissionsRoster.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              jambRegNo: '202611112222AA',
              departmentCode: 'CSC',
            }),
          }),
        );
      });

      it('prevents HOD from importing roster records for another department', async () => {
        // mockHodOther has departmentId 'dept-cyber' (code CYB)
        mockPrisma.department.findMany.mockResolvedValueOnce([
          { id: 'dept-cyber', code: 'CYB' },
          { id: 'dept-cs', code: 'CSC' },
        ]);

        const res = await service.bulkImportAdmissionsRoster(mockHodOther, {
          records: [
            {
              jambRegNo: '202611112222AA',
              fullName: 'Aisha Bello',
              departmentCode: 'CSC', // HOD belongs to CYB!
              session: '2026/2027',
            },
          ],
        });

        expect(res.invalid).toBe(1);
        expect(res.errors[0].reason).toContain('HOD cannot import roster records for another department');
      });
    });

    describe('submitStudentOnboarding (Matching Engine)', () => {
      it('successfully fast-tracks newly admitted student with zero document uploads when matching admissions roster', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-1',
          jambRegNo: '202699998888ZZ',
          matricNo: null,
          fullName: 'Emeka Chukwuma',
          departmentCode: 'CSC',
          level: 100,
          isClaimed: false,
          verificationKey: '37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f', // hash of 'default'
        });

        mockPrisma.admissionsRoster.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.user.create.mockResolvedValueOnce({
          id: 'usr-new-student',
          fullName: 'Emeka Chukwuma',
          role: Role.student,
          status: UserStatus.active,
          department: mockDepartmentCs,
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Emeka',
          surname: 'Chukwuma',
          departmentCode: 'CSC',
          jambRegNo: '202699998888ZZ',
        });

        expect(res.status).toBe('SUCCESS_ONBOARDED');
        expect(res.message).toContain('Student record successfully matched against admissions roster');
        expect((res as any).tokens).toBeDefined();
      });

      it('activates existing student record when matric number matches invited student on roster', async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          id: 'usr-invited-1',
          matricNo: 'CSC/2022/100',
          status: UserStatus.invited,
          role: Role.student,
        });

        mockPrisma.user.update.mockResolvedValueOnce({
          id: 'usr-invited-1',
          fullName: 'Ibrahim Musa',
          status: UserStatus.active,
          role: Role.student,
          department: mockDepartmentCs,
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Ibrahim',
          surname: 'Musa',
          matricNo: 'CSC/2022/100',
          departmentCode: 'CSC',
        });

        expect(res.status).toBe('SUCCESS_ONBOARDED');
        expect(res.message).toContain('Student account successfully matched and activated');
      });

      it('prevents claiming an already claimed admissions record and routes to exception queue', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-claimed',
          jambRegNo: '202688887777XX',
          isClaimed: true,
          departmentCode: 'CSC',
        });

        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);
        mockPrisma.onboardingApplication.create.mockResolvedValueOnce({
          applicationNumber: 'FOC-2026-CLAIM1',
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Pretender',
          surname: 'User',
          jambRegNo: '202688887777XX',
          departmentCode: 'CSC',
        });

        expect(res.status).toBe('EXCEPTION_RECORD_ALREADY_CLAIMED');
        expect(res.message).toContain('already been claimed by another account');
      });

      it('matches student with valid secondary verification secret and activates account', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-secret-1',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
          verificationKey: (service as any).hashToken('1999-10-15'),
          isClaimed: false,
        });

        mockPrisma.$transaction.mockImplementationOnce(async (callback: any) => {
          return callback({
            admissionsRoster: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
              update: jest.fn().mockResolvedValue({}),
            },
            user: {
              create: jest.fn().mockResolvedValue({
                id: 'usr-student-secret-1',
                fullName: 'Verified Student',
                email: 'verified@student.foc.edu.ng',
                status: UserStatus.active,
                role: Role.student,
                department: mockDepartmentCs,
              }),
            },
          });
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Verified',
          surname: 'Student',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
          verificationSecret: '1999-10-15',
        });

        expect(res.status).toBe('SUCCESS_ONBOARDED');
        expect((res as any).tokens).toBeDefined();
      });

      it('routes to exception review when secondary verification secret is incorrect', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-secret-2',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
          verificationKey: (service as any).hashToken('1999-10-15'),
          isClaimed: false,
        });

        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);
        mockPrisma.onboardingApplication.create.mockResolvedValueOnce({
          applicationNumber: 'FOC-2026-SECMIS1',
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Verified',
          surname: 'Student',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
          verificationSecret: 'wrong-secret',
        });

        expect(res.status).toBe('EXCEPTION_VERIFICATION_MISMATCH');
        expect(res.message).toContain('Secondary verification secret did not match');
        expect((res as any).tokens).toBeUndefined();
      });

      it('routes to exception review when secondary verification secret is omitted but roster requires it', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-secret-3',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
          verificationKey: (service as any).hashToken('PIN-1234'),
          isClaimed: false,
        });

        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);
        mockPrisma.onboardingApplication.create.mockResolvedValueOnce({
          applicationNumber: 'FOC-2026-SECMIS2',
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Verified',
          surname: 'Student',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
          // verificationSecret intentionally omitted
        });

        expect(res.status).toBe('EXCEPTION_VERIFICATION_MISMATCH');
        expect((res as any).tokens).toBeUndefined();
      });

      it('routes to exception review when department does not match admissions roster record', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-dept-mis',
          jambRegNo: '202611112222SS',
          departmentCode: 'SEN',
          verificationKey: (service as any).hashToken('default'),
          isClaimed: false,
        });

        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);
        mockPrisma.onboardingApplication.create.mockResolvedValueOnce({
          applicationNumber: 'FOC-2026-DEPTMIS1',
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Department',
          surname: 'Mismatch',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
        });

        expect(res.status).toBe('EXCEPTION_DEPARTMENT_MISMATCH');
        expect(res.message).toContain('does not match the admitted department');
        expect((res as any).tokens).toBeUndefined();
      });

      it('detects existing active account conflict when matriculation number already belongs to active user', async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          id: 'usr-active-existing',
          matricNo: 'CSC/2021/001',
          status: UserStatus.active,
          role: Role.student,
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Existing',
          surname: 'Student',
          matricNo: 'CSC/2021/001',
          departmentCode: 'CSC',
        });

        expect(res.status).toBe('CONFLICT_EXISTING_ACCOUNT');
        expect(res.message).toContain('active account already exists');
      });

      it('routes to exception review when submitted candidate name does not match admissions roster record', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce({
          id: 'adm-rec-name-mis',
          jambRegNo: '202611112222SS',
          fullName: 'Chukwuma David Okafor',
          departmentCode: 'CSC',
          verificationKey: (service as any).hashToken('default'),
          isClaimed: false,
        });

        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);
        mockPrisma.onboardingApplication.create.mockResolvedValueOnce({
          applicationNumber: 'FOC-2026-NAMEMIS1',
        });

        // Imposter submits completely different names
        const res = await service.submitStudentOnboarding({
          firstName: 'Imposter',
          surname: 'Intruder',
          jambRegNo: '202611112222SS',
          departmentCode: 'CSC',
        });

        expect(res.status).toBe('EXCEPTION_NAME_MISMATCH');
        expect(res.message).toContain('does not match the official admissions roster record');
        expect((res as any).tokens).toBeUndefined();
      });

      it('routes unmatched student to exception queue without granting academic access', async () => {
        mockPrisma.admissionsRoster.findUnique.mockResolvedValueOnce(null); // Not on roster
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);
        mockPrisma.onboardingApplication.create.mockResolvedValueOnce({
          applicationNumber: 'FOC-2026-EXCP01',
        });

        const res = await service.submitStudentOnboarding({
          firstName: 'Unmatched',
          surname: 'Candidate',
          jambRegNo: '202600000000UN',
          departmentCode: 'CSC',
        });

        expect(res.status).toBe('EXCEPTION_UNMATCHED_RECORD');
        expect(res.message).toContain('Your admission record could not be matched automatically');
        expect((res as any).tokens).toBeUndefined(); // Crucial: no access token issued!
      });
    });

    describe('resolveExceptionCase (Staff Review)', () => {
      it('allows authorized Admin/HOD to approve an exception case and provision student record', async () => {
        mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
          id: 'app-excp-1',
          fullName: 'Amina Review',
          email: 'amina@foc.edu.ng',
          departmentId: 'dept-cs',
          status: OnboardingStatus.under_review,
        });

        mockPrisma.user.findUnique.mockResolvedValueOnce(null); // No existing matric conflict
        mockPrisma.user.create.mockResolvedValueOnce({
          id: 'usr-student-approved',
          fullName: 'Amina Review',
          role: Role.student,
          status: UserStatus.active,
        });
        mockPrisma.onboardingApplication.update.mockResolvedValueOnce({
          id: 'app-excp-1',
          status: OnboardingStatus.verified,
        });

        const res = await service.resolveExceptionCase(mockAdminUser, 'app-excp-1', {
          action: 'APPROVE',
          assignedMatricNo: 'CSC/2026/999',
        });

        expect(res.status).toBe('VERIFIED');
        expect((res as any).userId).toBe('usr-student-approved');
        expect(mockPrisma.onboardingReviewLog.create).toHaveBeenCalled();
      });

      it('prevents HOD from resolving exception cases belonging to another department', async () => {
        mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
          id: 'app-excp-cs',
          departmentId: 'dept-cs',
        });

        // mockHodOther has departmentId 'dept-cyber'
        await expect(
          service.resolveExceptionCase(mockHodOther, 'app-excp-cs', { action: 'APPROVE' }),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('Application Tracking (Multi-Identifier & Access Security)', () => {
      it('successfully tracks an application using applicationNumber and email identifier', async () => {
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce({
          id: 'app-1',
          applicationNumber: 'FOC-2026-F2A982',
          jambRegNo: 'APP/4D5B440E',
          fullName: 'Mene Gideon',
          email: 'menegideon84@gmail.com',
          phone: '09063979730',
          entryLevel: 100,
          session: '2026/2027',
          status: OnboardingStatus.under_review,
          department: mockDepartmentCs,
          documents: [],
          reviewLogs: [],
        });

        const res = await service.trackApplication({
          applicationNumber: 'FOC-2026-F2A982',
          identifier: 'menegideon84@gmail.com',
        });

        expect(res.application).toBeDefined();
        expect(res.application.applicationNumber).toBe('FOC-2026-F2A982');
        expect(res.candidateToken).toBe('mock-candidate-jwt');
      });

      it('successfully tracks an application using applicationNumber and matriculation number', async () => {
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce({
          id: 'app-2',
          applicationNumber: 'FOC-2026-C1D2E3',
          jambRegNo: 'CSC/2023/042',
          fullName: 'Continuing Student',
          email: 'student@gmail.com',
          entryLevel: 300,
          session: '2026/2027',
          status: OnboardingStatus.under_review,
          department: mockDepartmentCs,
          documents: [],
          reviewLogs: [],
        });

        const res = await service.trackApplication({
          applicationNumber: 'FOC-2026-C1D2E3',
          identifier: 'CSC/2023/042',
        });

        expect(res.application.applicationNumber).toBe('FOC-2026-C1D2E3');
      });

      it('retains backward compatibility tracking with jambRegNo parameter', async () => {
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce({
          id: 'app-3',
          applicationNumber: 'APP-2025-ABC123',
          jambRegNo: '202611223344AA',
          fullName: 'Freshman Candidate',
          email: 'freshman@gmail.com',
          entryLevel: 100,
          session: '2025/2026',
          status: OnboardingStatus.draft,
          department: mockDepartmentCs,
          documents: [],
          reviewLogs: [],
        });

        const res = await service.trackApplication({
          applicationNumber: 'APP-2025-ABC123',
          jambRegNo: '202611223344AA',
        });

        expect(res.application.applicationNumber).toBe('APP-2025-ABC123');
      });

      it('rejects tracking request if identifier is missing or empty', async () => {
        await expect(
          service.trackApplication({
            applicationNumber: 'FOC-2026-ABC123',
            identifier: '',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('successfully tracks an application using applicationNumber and phone identifier', async () => {
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce({
          id: 'app-phone-1',
          applicationNumber: 'FOC-2026-PHONE1',
          jambRegNo: 'APP/PHONE123',
          fullName: 'Phone Candidate',
          email: 'phone@candidate.com',
          phone: '08099887766',
          entryLevel: 100,
          session: '2026/2027',
          status: OnboardingStatus.under_review,
          department: mockDepartmentCs,
          documents: [],
          reviewLogs: [],
        });

        const res = await service.trackApplication({
          applicationNumber: 'FOC-2026-PHONE1',
          identifier: '08099887766',
        });

        expect(res.application).toBeDefined();
        expect(res.application.applicationNumber).toBe('FOC-2026-PHONE1');
      });

      it('normalizes identifier whitespace and case when tracking', async () => {
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce({
          id: 'app-norm-1',
          applicationNumber: 'FOC-2026-NORM01',
          jambRegNo: '2026NORM1234AB',
          fullName: 'Norm Candidate',
          email: 'norm@example.com',
          entryLevel: 100,
          session: '2026/2027',
          status: OnboardingStatus.under_review,
          department: mockDepartmentCs,
          documents: [],
          reviewLogs: [],
        });

        const res = await service.trackApplication({
          applicationNumber: '  foc-2026-norm01  ',
          identifier: '  2026norm1234ab  ',
        });

        expect(res.application.applicationNumber).toBe('FOC-2026-NORM01');
      });

      it('enforces dual-factor application lookup: correct application reference with another candidate identifier returns NotFoundException', async () => {
        // Prisma findFirst will return null because the OR clause does not match the record with this applicationNumber
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);

        await expect(
          service.trackApplication({
            applicationNumber: 'FOC-2026-TARGET1',
            identifier: 'attacker-or-other-student@gmail.com',
          }),
        ).rejects.toThrow('No matching application record found');
      });

      it('throws NotFoundException when no matching application exists without exposing sensitive data', async () => {
        mockPrisma.onboardingApplication.findFirst.mockResolvedValueOnce(null);

        await expect(
          service.trackApplication({
            applicationNumber: 'FOC-2026-UNKNOWN',
            identifier: 'wrong@example.com',
          }),
        ).rejects.toThrow('No matching application record found');
      });
    });
  });
});
