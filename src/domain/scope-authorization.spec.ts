import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CoursesService } from './courses.service';
import { AssignmentsService } from './assignments.service';
import { PastQuestionsService } from './past-questions.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import { AuthService } from '../auth/auth.service';

describe('Domain Services - Negative Authorization & Scope Scenarios', () => {
  let coursesService: CoursesService;
  let assignmentsService: AssignmentsService;
  let pastQuestionsService: PastQuestionsService;

  let prisma: any;
  let audit: any;
  let storage: any;
  let auth: any;

  const csHodUser: any = {
    id: 'hod-cs',
    fullName: 'Dr. CS HOD',
    role: Role.hod,
    departmentId: 'dept-cs',
    department: 'Computer Science',
  };

  const lecturerUser: any = {
    id: 'lec-1',
    fullName: 'Dr. Lecturer',
    role: Role.lecturer,
    departmentId: 'dept-cs',
    department: 'Computer Science',
  };

  const student1: any = {
    id: 'student-1',
    fullName: 'Amina Bello',
    role: Role.student,
    matricNo: 'CSC/2022/084',
    departmentId: 'dept-cs',
  };

  const student2: any = {
    id: 'student-2',
    fullName: 'Babajide Cole',
    role: Role.student,
    matricNo: 'CSC/2022/085',
    departmentId: 'dept-cs',
  };

  const courseRep: any = {
    id: 'rep-1',
    fullName: 'Chidi Rep',
    role: Role.course_rep,
    matricNo: 'CSC/2022/012',
    departmentId: 'dept-cs',
  };

  beforeEach(async () => {
    prisma = {
      course: { findUnique: jest.fn(), findMany: jest.fn() },
      offering: { findUnique: jest.fn(), findMany: jest.fn() },
      offeringLecturer: { findUnique: jest.fn() },
      module: { create: jest.fn(), findUnique: jest.fn() },
      material: { create: jest.fn(), findUnique: jest.fn() },
      assignment: { create: jest.fn(), findUnique: jest.fn() },
      submission: { findUnique: jest.fn(), findMany: jest.fn() },
      pastQuestion: { findUnique: jest.fn(), update: jest.fn() },
    };

    audit = { log: jest.fn().mockResolvedValue(undefined) };
    storage = { putObject: jest.fn(), getObject: jest.fn() };
    auth = { effectiveRole: jest.fn((u) => u.role) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoursesService,
        AssignmentsService,
        PastQuestionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: StorageService, useValue: storage },
        { provide: AuthService, useValue: auth },
      ],
    }).compile();

    coursesService = module.get<CoursesService>(CoursesService);
    assignmentsService = module.get<AssignmentsService>(AssignmentsService);
    pastQuestionsService = module.get<PastQuestionsService>(PastQuestionsService);
  });

  describe('CoursesService - Scope & Delegation', () => {
    it('blocks HOD from creating modules in an offering of another department', async () => {
      prisma.offering.findUnique.mockResolvedValue({
        id: 'off-se',
        course: { departmentId: 'dept-se' }, // not dept-cs!
      });

      await expect(
        coursesService.createModule('off-se', csHodUser, {
          title: 'Week 1',
          order: 1,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks unassigned lecturer from creating modules', async () => {
      prisma.offeringLecturer.findUnique.mockResolvedValue(null);

      await expect(
        coursesService.createModule('off-1', lecturerUser, {
          title: 'Week 1',
          order: 1,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('AssignmentsService - Permissions & Privacy', () => {
    it('blocks HOD from creating assignments for courses in another department', async () => {
      prisma.offering.findUnique.mockResolvedValue({
        id: 'off-se',
        course: { departmentId: 'dept-se' },
        lecturers: [],
      });

      await expect(
        assignmentsService.create(csHodUser, {
          courseId: 'crs-se',
          offeringId: 'off-se',
          courseCode: 'SEN 301',
          department: 'Software Engineering',
          level: '300',
          title: 'SE Assignment',
          instructions: 'Solve this',
          dueDate: '2026-11-01T00:00:00Z',
          totalMarks: 20,
          allowedFileTypes: ['.pdf'],
          maxSizeBytes: 10485760,
          allowLate: false,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents course reps from accessing or downloading submission files', async () => {
      await expect(
        assignmentsService.getSubmissionFile('asg-1', 'sub-1', courseRep),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents a student from downloading another students submission file', async () => {
      prisma.submission.findUnique.mockResolvedValue({
        id: 'sub-1',
        assignmentId: 'asg-1',
        studentId: student2.id, // belongs to student 2!
        assignment: {
          offering: { course: { departmentId: 'dept-cs' }, lecturers: [] },
        },
        versions: [{ fileKey: 'test-key', fileName: 'sol.pdf', sizeBytes: 100 }],
      });

      await expect(
        assignmentsService.getSubmissionFile('asg-1', 'sub-1', student1),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents students from accessing headcount', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: 'asg-1',
        offering: { enrollments: [] },
        submissions: [],
      });

      await expect(
        assignmentsService.headcount('asg-1', student1),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents unassigned course rep from accessing headcount for non-enrolled courses', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: 'asg-1',
        offering: {
          course: { departmentId: 'dept-cs' },
          lecturers: [],
          enrollments: [{ userId: 'other-student' }], // rep is not enrolled
        },
        submissions: [],
      });

      await expect(
        assignmentsService.headcount('asg-1', courseRep),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('PastQuestionsService - HOD Scope', () => {
    it('prevents HOD from reviewing past questions for courses in another department', async () => {
      prisma.pastQuestion.findUnique.mockResolvedValue({
        id: 'pq-se',
        courseCode: 'SEN 201',
        uploader: { department: { name: 'Software Engineering' } },
      });
      prisma.course.findUnique.mockResolvedValue({
        id: 'crs-sen',
        code: 'SEN 201',
        department: { name: 'Software Engineering' }, // not Computer Science!
      });

      await expect(
        pastQuestionsService.review('pq-se', csHodUser, true),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents HOD from deleting past questions of another department', async () => {
      prisma.pastQuestion.findUnique.mockResolvedValue({
        id: 'pq-se',
        courseCode: 'SEN 201',
        uploaderId: 'other-user',
        uploader: { department: { name: 'Software Engineering' } },
      });
      prisma.course.findUnique.mockResolvedValue({
        id: 'crs-sen',
        code: 'SEN 201',
        department: { name: 'Software Engineering' },
      });

      await expect(
        pastQuestionsService.remove('pq-se', csHodUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
