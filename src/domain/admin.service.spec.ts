import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';

describe('AdminService - Phase 2 Scope & Bulk Import', () => {
  let service: AdminService;
  let prisma: any;
  let audit: any;

  const mockDeptCs = { id: 'dept-cs', code: 'CSC', name: 'Computer Science' };
  const mockDeptSe = { id: 'dept-se', code: 'SEN', name: 'Software Engineering' };

  const adminActor = {
    id: 'usr-admin',
    fullName: 'Prof. Admin',
    role: Role.admin,
    departmentId: null,
  };

  const csHodActor = {
    id: 'usr-hod-cs',
    fullName: 'Dr. CS HOD',
    role: Role.hod,
    departmentId: 'dept-cs',
  };

  beforeEach(async () => {
    prisma = {
      department: {
        findMany: jest.fn().mockResolvedValue([mockDeptCs, mockDeptSe]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      offering: {
        findUnique: jest.fn(),
      },
      enrollment: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };

    audit = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  describe('bulkUpsertStudents', () => {
    it('creates students in batch and reports summary with audit log', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: `created-${data.matricNo}`,
          ...data,
          department: mockDeptCs,
        }),
      );

      const result = await service.bulkUpsertStudents(adminActor, {
        students: [
          {
            matricNo: 'CSC/2026/001',
            fullName: 'Amina Bello',
            department: 'Computer Science',
            level: '100',
            status: 'invited',
          },
          {
            matricNo: 'CSC/2026/002',
            fullName: 'Babajide Cole',
            department: 'CSC',
            level: '200',
            status: 'invited',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.total).toBe(2);
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.rejected.length).toBe(0);
      expect(prisma.user.create).toHaveBeenCalledTimes(2);
      expect(audit.log).toHaveBeenCalledWith(
        adminActor,
        'BULK_IMPORT_STUDENTS',
        'User',
        'bulk',
        expect.stringContaining('2 created'),
        undefined,
        expect.any(Object),
        prisma,
      );
    });

    it('rejects rows with unrecognized department with row number and reason', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.bulkUpsertStudents(adminActor, {
        students: [
          {
            matricNo: 'BIO/2026/001',
            fullName: 'Unknown Dept Student',
            department: 'Biochemistry',
            level: '100',
          },
        ],
      });

      expect(result.created).toBe(0);
      expect(result.rejected.length).toBe(1);
      expect(result.rejected[0]).toEqual({
        matricNo: 'BIO/2026/001',
        row: 1,
        reason: "Department 'Biochemistry' not recognized",
      });
    });

    it('enforces HOD department scope and rejects student from another department', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.bulkUpsertStudents(csHodActor, {
        students: [
          {
            matricNo: 'SEN/2026/001',
            fullName: 'Software Student',
            department: 'Software Engineering',
            level: '100',
          },
        ],
      });

      expect(result.created).toBe(0);
      expect(result.rejected.length).toBe(1);
      expect(result.rejected[0].reason).toContain('HOD cannot import students outside their assigned department');
    });

    it('handles duplicate matrics inside import batch by skipping when skipDuplicates is true', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: `created-${data.matricNo}`,
          ...data,
          department: mockDeptCs,
        }),
      );

      const result = await service.bulkUpsertStudents(adminActor, {
        skipDuplicates: true,
        students: [
          {
            matricNo: 'CSC/2026/010',
            fullName: 'First Entry',
            department: 'Computer Science',
            level: '100',
          },
          {
            matricNo: 'CSC/2026/010',
            fullName: 'Duplicate In Batch',
            department: 'Computer Science',
            level: '100',
          },
        ],
      });

      expect(result.created).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.rejected.length).toBe(0);
    });

    it('prevents HOD from modifying an existing student belonging to another department', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'existing-se-student',
          matricNo: 'SEN/2026/050',
          departmentId: 'dept-se',
          status: UserStatus.invited,
        },
      ]);

      const result = await service.bulkUpsertStudents(csHodActor, {
        students: [
          {
            matricNo: 'SEN/2026/050',
            fullName: 'Hijacked Student',
            department: 'Computer Science',
            level: '100',
          },
        ],
      });

      expect(result.updated).toBe(0);
      expect(result.rejected.length).toBe(1);
      expect(result.rejected[0].reason).toContain('Existing student belongs to another department');
    });
  });

  describe('upsertStudent (Single)', () => {
    it('blocks HOD from modifying an existing student from another department', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDeptCs);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-se',
        matricNo: 'SEN/2022/001',
        departmentId: 'dept-se',
      });

      await expect(
        service.upsertStudent(csHodActor, {
          matricNo: 'SEN/2022/001',
          fullName: 'Attempted Hijack',
          department: 'Computer Science',
          level: '200',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('offeringEnrollments & enroll HOD scoping', () => {
    it('throws ForbiddenException when HOD views enrollments for a course in another department', async () => {
      prisma.offering.findUnique.mockResolvedValue({
        id: 'offering-se',
        course: { departmentId: 'dept-se' },
      });

      await expect(
        service.offeringEnrollments(csHodActor, 'offering-se'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when HOD attempts to enroll a student in another department offering', async () => {
      prisma.offering.findUnique.mockResolvedValue({
        id: 'offering-se',
        course: { departmentId: 'dept-se' },
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'student-1',
        departmentId: 'dept-cs',
      });

      await expect(
        service.enroll(csHodActor, 'offering-se', {
          userId: 'student-1',
          type: 'regular',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
