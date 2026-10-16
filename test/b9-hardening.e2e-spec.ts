import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import request = require('supertest');
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import {
  Role,
  UserStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { validateEnvironment } from '../src/common/config.validator';

describe('Phase B9: Hardening & Postgres Verification Suite', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let _hodToken: string;
  let lecturerToken: string;
  let studentToken: string;
  let secondStudentToken: string;
  let repToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const testDbUrl =
      process.env.TEST_DATABASE_URL ||
      'postgresql://codics:codics@127.0.0.1:5432/codics_test?schema=public';

    // Abort if TEST_DATABASE_URL points at a remote/non-local host
    if (!testDbUrl.includes('localhost') && !testDbUrl.includes('127.0.0.1')) {
      throw new Error(
        'SECURITY ABORT: TEST_DATABASE_URL must point to a local test database!',
      );
    }
    process.env.DATABASE_URL = testDbUrl;
    process.env.JWT_SECRET =
      'codics-b9-test-secret-with-plenty-of-entropy-96-chars-0123456789abcdef';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    // Create a second student for isolation tests
    const student2PasswordHash = await hash('password123', 10);
    await prisma.user.upsert({
      where: { matricNo: 'CSC/2022/099' },
      update: {},
      create: {
        id: 'usr-student-02',
        fullName: 'Second Student',
        email: 'second.student@foc.edu.ng',
        matricNo: 'CSC/2022/099',
        passwordHash: student2PasswordHash,
        role: Role.student,
        status: UserStatus.active,
        departmentId: 'dept-csc',
        level: 300,
      },
    });

    // Obtain tokens
    const adminRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'dean.computing@foc.edu.ng', password: 'password123' });
    adminToken = adminRes.body.accessToken;

    const hodRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'hod.cs@foc.edu.ng', password: 'password123' });
    _hodToken = hodRes.body.accessToken;

    const lecturerRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'i.adeleke@foc.edu.ng', password: 'password123' });
    lecturerToken = lecturerRes.body.accessToken;

    const studentRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'CSC/2022/084', password: 'password123' });
    studentToken = studentRes.body.accessToken;

    const student2Res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'CSC/2022/099', password: 'password123' });
    secondStudentToken = student2Res.body.accessToken;

    const repRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'SEN/2022/012', password: 'password123' });
    repToken = repRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Boot failure tests
  describe('1. Boot Rejection on Invalid Secret', () => {
    it('refuses to validate with missing JWT_SECRET in production/dev', () => {
      expect(() =>
        validateEnvironment({
          NODE_ENV: 'development',
          PORT: 3000,
          JWT_SECRET: undefined as any,
        }),
      ).toThrow();
    });

    it('refuses to validate with secret < 32 chars', () => {
      expect(() =>
        validateEnvironment({
          NODE_ENV: 'development',
          PORT: 3000,
          JWT_SECRET: 'short-secret-under-32-chars',
        }),
      ).toThrow();
    });

    it('refuses to validate with placeholder secret', () => {
      expect(() =>
        validateEnvironment({
          NODE_ENV: 'production',
          PORT: 3000,
          JWT_SECRET: 'development-secret-change-me-please-long-enough-now',
        }),
      ).toThrow();
    });
  });

  // 2. Database Unique Constraints
  describe('2. Database Unique Constraints', () => {
    it('rejects duplicate user matricNo at the database layer', async () => {
      await expect(
        prisma.user.create({
          data: {
            fullName: 'Duplicate Matric User',
            matricNo: 'CSC/2022/084', // Existing student matric
            role: Role.student,
            status: UserStatus.active,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects duplicate enrollment (offeringId, userId) at the database layer', async () => {
      // Existing enrollment: enr-001 has offeringId: offering for CSC 301, userId: usr-student-01
      const existing = await prisma.enrollment.findFirst();
      expect(existing).toBeDefined();

      await expect(
        prisma.enrollment.create({
          data: {
            offeringId: existing!.offeringId,
            userId: existing!.userId,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects duplicate past question upload via conflict exception and partial unique index', async () => {
      // Create a base past question
      const paperCode = `CSCTEST_${Date.now()}`;
      await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: paperCode,
          courseTitle: 'Test Course',
          department: 'Computer Science',
          level: '300',
          session: '2023/2024',
          semester: 'First Semester',
          examType: 'exam',
          fileName: `${paperCode}.pdf`,
          fileUrl: 'http://test.url',
        })
        .expect(201);

      // Attempting to upload the exact duplicate paper returns 409 Conflict
      const dupRes = await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: paperCode,
          courseTitle: 'Test Course',
          department: 'Computer Science',
          level: '300',
          session: '2023/2024',
          semester: 'First Semester',
          examType: 'exam',
          fileName: `${paperCode}.pdf`,
          fileUrl: 'http://test.url',
        })
        .expect(409);

      expect(dupRes.body.message).toContain('already exists');
    });
  });

  // 3. Soft Delete Exclusions
  describe('3. Soft Delete Exclusions', () => {
    it('excludes soft-deleted module and materials from course offering views', async () => {
      const offering = await prisma.offering.findFirst({
        include: { modules: true },
      });
      expect(offering).toBeDefined();

      // Create a module to delete
      const modRes = await request(app.getHttpServer())
        .post(`/api/v1/offerings/${offering!.id}/modules`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Module to be Deleted', order: 99 })
        .expect(201);

      const moduleId = modRes.body.id;

      // Create a material inside that module
      const matRes = await request(app.getHttpServer())
        .post(`/api/v1/modules/${moduleId}/materials`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Material to be Deleted',
          type: 'note',
          contentOrUrl: 'Some notes',
          status: 'published',
        })
        .expect(201);
      expect(matRes.body.id).toBeDefined();

      // Verify it appears in offering
      const beforeOffering = await request(app.getHttpServer())
        .get(`/api/v1/offerings/${offering!.id}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);

      expect(beforeOffering.body.modules.some((m: any) => m.id === moduleId)).toBe(true);

      // Soft delete the module
      await request(app.getHttpServer())
        .delete(`/api/v1/modules/${moduleId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Verify module and material no longer appear in offering view
      const afterOffering = await request(app.getHttpServer())
        .get(`/api/v1/offerings/${offering!.id}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);

      expect(afterOffering.body.modules.some((m: any) => m.id === moduleId)).toBe(false);

      // Verify in DB that deletedAt is populated
      const dbModule = await prisma.module.findUnique({ where: { id: moduleId } });
      expect(dbModule!.deletedAt).not.toBeNull();
    });

    it('excludes soft-deleted past questions from list endpoints', async () => {
      const paperCode = `SOFTDEL_${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: paperCode,
          courseTitle: 'Soft Delete Course',
          department: 'Computer Science',
          level: '100',
          session: '2023/2024',
          semester: 'Second Semester',
          examType: 'exam',
          fileName: `${paperCode}.pdf`,
          fileUrl: 'http://test.url',
        })
        .expect(201);

      const paperId = res.body.id;

      // Verify paper is in list
      const listBefore = await request(app.getHttpServer())
        .get(`/api/v1/past-questions?courseCode=${paperCode}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);
      expect(listBefore.body.items.some((p: any) => p.id === paperId)).toBe(true);

      // Delete the paper
      await request(app.getHttpServer())
        .delete(`/api/v1/past-questions/${paperId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Verify paper is excluded from list
      const listAfter = await request(app.getHttpServer())
        .get(`/api/v1/past-questions?courseCode=${paperCode}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);
      expect(listAfter.body.items.some((p: any) => p.id === paperId)).toBe(false);

      // Verify directly in DB that deletedAt is populated
      const dbPaper = await prisma.pastQuestion.findUnique({ where: { id: paperId } });
      expect(dbPaper!.deletedAt).not.toBeNull();
    });
  });

  // 4. Uniform Activation Error Responses
  describe('4. Uniform Activation Error Responses', () => {
    it('returns identical 400 response for unknown matric, already active student, and wrong code', async () => {
      // 1. Unknown matric
      const resUnknown = await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        .send({
          matricNo: 'CSC/2022/999',
          activationCode: '123456',
          password: 'Password123!',
        });

      // 2. Already active student
      const resActive = await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        .send({
          matricNo: 'CSC/2022/084',
          activationCode: '123456',
          password: 'Password123!',
        });

      // 3. Known inactive user with invalid code
      await prisma.user.upsert({
        where: { matricNo: 'SEN/2022/888' },
        update: {},
        create: {
          fullName: 'Inactive Student',
          matricNo: 'SEN/2022/888',
          role: Role.student,
          status: UserStatus.invited,
        },
      });

      const resWrongCode = await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        .send({
          matricNo: 'SEN/2022/888',
          activationCode: '000000',
          password: 'Password123!',
        });

      expect(resUnknown.status).toBe(400);
      expect(resActive.status).toBe(400);
      expect(resWrongCode.status).toBe(400);

      expect(resUnknown.body.message).toBe('Invalid or expired activation details');
      expect(resActive.body.message).toBe('Invalid or expired activation details');
      expect(resWrongCode.body.message).toBe('Invalid or expired activation details');
    });
  });

  // 5. Refresh Token Family & Reuse Detection
  describe('5. Refresh Token Rotation and Reuse Detection', () => {
    it('rotates refresh token and revokes entire family upon reuse detection', async () => {
      // 1. Login
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'CSC/2022/084', password: 'password123' })
        .expect(201);

      const firstRefreshToken = loginRes.body.refreshToken;
      expect(firstRefreshToken).toBeDefined();

      // 2. Refresh tokens using the first token
      const refreshRes1 = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: firstRefreshToken })
        .expect(201);

      const secondRefreshToken = refreshRes1.body.refreshToken;
      expect(secondRefreshToken).toBeDefined();
      expect(secondRefreshToken).not.toBe(firstRefreshToken);

      // 3. Attempt to REUSE the first token (which was already rotated/replaced)
      const reuseRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: firstRefreshToken });

      // Reuse detection triggers: 401 Unauthorized
      expect(reuseRes.status).toBe(401);

      // 4. Verify that the entire token family was revoked:
      // Even the active secondRefreshToken is now revoked!
      const subsequentRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: secondRefreshToken });

      expect(subsequentRes.status).toBe(401);
    });
  });

  // 6. Password Reset Flow
  describe('6. Password Reset Flow', () => {
    it('completes the password reset cycle and invalidates token on use', async () => {
      const email = 'reset.user@foc.edu.ng';
      const initialHash = await hash('password123', 10);
      await prisma.user.upsert({
        where: { email },
        update: { passwordHash: initialHash },
        create: {
          fullName: 'Reset Test User',
          email,
          matricNo: 'RES/2022/111',
          passwordHash: initialHash,
          role: Role.student,
          status: UserStatus.active,
          departmentId: 'dept-csc',
          level: 300,
        },
      });

      // 1. Request forgot password
      const forgotRes = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot')
        .send({ identifier: email })
        .expect(200);

      expect(forgotRes.body.success).toBe(true);

      // In tests, find the generated reset record from DB
      const resetRecord = await prisma.passwordReset.findFirst({
        where: { user: { email }, usedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(resetRecord).toBeDefined();

      // Create a test known token hash to test reset endpoint
      const rawToken = 'test-reset-token-' + randomUUID();
      const tokenHash = require('crypto').createHash('sha256').update(rawToken).digest('hex');
      await prisma.passwordReset.create({
        data: {
          userId: resetRecord!.userId,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      // 2. Perform reset
      const resetRes = await request(app.getHttpServer())
        .post('/api/v1/auth/reset')
        .send({ token: rawToken, newPassword: 'UpdatedPassword1!' })
        .expect(200);

      expect(resetRes.body.success).toBe(true);

      // 3. Can login with new password
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email, password: 'UpdatedPassword1!' })
        .expect(201);

      // 4. Reusing the reset token fails
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset')
        .send({ token: rawToken, newPassword: 'AnotherPassword2!' })
        .expect(400);

      // Restore password back to password123 for other tests
      const restoredHash = await hash('password123', 10);
      await prisma.user.update({
        where: { email },
        data: { passwordHash: restoredHash },
      });
    });
  });

  // 7. AuditLog Append-Only Triggers
  describe('7. AuditLog Append-Only Database Triggers', () => {
    it('strictly raises database exceptions on UPDATE and DELETE to AuditLog', async () => {
      // 1. Insert an audit log entry
      const logEntry = await prisma.auditLog.create({
        data: {
          action: 'TEST_APPEND_ONLY',
          targetType: 'System',
          targetId: 'sys-01',
          actorRole: 'admin',
        },
      });

      // 2. Attempt UPDATE -> database trigger must reject
      await expect(
        prisma.$executeRaw`UPDATE "AuditLog" SET "action" = 'tampered' WHERE "id" = ${logEntry.id}::uuid`,
      ).rejects.toThrow();

      // 3. Attempt DELETE -> database trigger must reject
      await expect(
        prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${logEntry.id}::uuid`,
      ).rejects.toThrow();
    });
  });

  // 8. Download Permission Matrix
  describe('8. Download Permission Matrix', () => {
    let testAssignmentId: string;
    let testSubmissionId: string;
    let approvedPqId: string;
    let pendingPqId: string;

    beforeAll(async () => {
      // Submit work for student 1
      const subRes = await request(app.getHttpServer())
        .post('/api/v1/assignments/asg-csc301-1/submissions')
        .set('Authorization', `Bearer ${studentToken}`)
        .attach('file', Buffer.from('%PDF-1.4 Student 1 Submission Content'), 'student1.pdf')
        .expect(201);

      testAssignmentId = 'asg-csc301-1';
      testSubmissionId = subRes.body.id;

      // Upload an approved past question by Lecturer
      const pqAppRes = await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${lecturerToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: `CSC301_APP_${Date.now()}`,
          courseTitle: 'Algorithms',
          department: 'Computer Science',
          level: '300',
          session: '2022/2023',
          semester: 'First Semester',
          examType: 'exam',
          fileName: 'csc301_exam.pdf',
          fileUrl: 'http://test.url',
        })
        .expect(201);
      approvedPqId = pqAppRes.body.id;

      // Upload a pending past question by active Course Rep
      const pqPendRes = await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${repToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: `SEN301_PEND_${Date.now()}`,
          courseTitle: 'Software Architecture',
          department: 'Software Engineering',
          level: '300',
          session: '2023/2024',
          semester: 'First Semester',
          examType: 'exam',
          fileName: 'sen301_exam.pdf',
          fileUrl: 'http://test.url',
        })
        .expect(201);
      pendingPqId = pqPendRes.body.id;
    });

    it('submission download permissions: student owns work -> 200', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/assignments/${testAssignmentId}/submissions/${testSubmissionId}/download`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);

      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.body.toString()).toContain('%PDF-1.4');
    });

    it('submission download permissions: other student -> 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/assignments/${testAssignmentId}/submissions/${testSubmissionId}/download`)
        .set('Authorization', `Bearer ${secondStudentToken}`)
        .expect(403);
    });

    it('submission download permissions: course representative -> 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/assignments/${testAssignmentId}/submissions/${testSubmissionId}/download`)
        .set('Authorization', `Bearer ${repToken}`)
        .expect(403);
    });

    it('submission download permissions: assigned lecturer -> 200', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/assignments/${testAssignmentId}/submissions/${testSubmissionId}/download`)
        .set('Authorization', `Bearer ${lecturerToken}`)
        .expect(200);
    });

    it('submission download permissions: admin -> 200', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/assignments/${testAssignmentId}/submissions/${testSubmissionId}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('past question download: approved paper accessible to all authenticated users', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/past-questions/${approvedPqId}/download`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);
    });

    it('past question download: pending paper forbidden to other students', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/past-questions/${pendingPqId}/download`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(403);
    });

    it('past question download: pending paper accessible to uploader and admin', async () => {
      // Accessible to uploader (rep)
      await request(app.getHttpServer())
        .get(`/api/v1/past-questions/${pendingPqId}/download`)
        .set('Authorization', `Bearer ${repToken}`)
        .expect(200);

      // Accessible to admin
      await request(app.getHttpServer())
        .get(`/api/v1/past-questions/${pendingPqId}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  // 9. Cursor Pagination
  describe('9. Cursor Pagination', () => {
    it('returns nextCursor and streams notices correctly across pages', async () => {
      // Create 3 notices to test pagination
      for (let i = 1; i <= 3; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/notices')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            title: `Pagination Test Notice ${i}`,
            content: `Body for notice ${i}`,
            category: 'general',
            scope: 'faculty',
          });
      }

      // First page with limit 1
      const page1Res = await request(app.getHttpServer())
        .get('/api/v1/notices?limit=1')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);

      expect(page1Res.body.items).toHaveLength(1);
      expect(page1Res.body.nextCursor).toBeDefined();
      expect(typeof page1Res.body.nextCursor).toBe('string');

      const nextCursor = page1Res.body.nextCursor;

      // Second page with cursor
      const page2Res = await request(app.getHttpServer())
        .get(`/api/v1/notices?limit=1&cursor=${nextCursor}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);

      expect(page2Res.body.items).toHaveLength(1);
      expect(page2Res.body.items[0].id).not.toBe(page1Res.body.items[0].id);
    });
  });

  // 10. Course Rep Term Expiry & Permission Rules
  describe('10. Course Rep Term Expiry & Permission Rules', () => {
    it('expired course rep acts as a student: cannot upload PQ or publish notices', async () => {
      // Create an expired course rep
      const expiredRep = await prisma.user.upsert({
        where: { matricNo: 'EXP/2022/777' },
        update: {
          repTermEnd: new Date(Date.now() - 1000 * 60 * 60 * 24),
          role: Role.course_rep,
        },
        create: {
          fullName: 'Expired Rep User',
          email: `expired.rep.${Date.now()}@foc.edu.ng`,
          matricNo: 'EXP/2022/777',
          passwordHash: await hash('password123', 10),
          role: Role.course_rep,
          status: UserStatus.active,
          repTermEnd: new Date(Date.now() - 1000 * 60 * 60 * 24), // Expired yesterday
          departmentId: 'dept-csc',
          level: 300,
        },
      });

      const expLoginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: expiredRep.matricNo!, password: 'password123' })
        .expect(201);

      const expiredRepToken = expLoginRes.body.accessToken;
      expect(expLoginRes.body.user.role).toBe('student'); // effectiveRole downgraded

      // Attempt to publish notice -> 403 Forbidden
      await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set('Authorization', `Bearer ${expiredRepToken}`)
        .send({
          title: 'Expired Rep Notice',
          content: 'This should fail',
          category: 'general',
          scope: 'faculty',
        })
        .expect(403);

      // Attempt to upload past question -> 403 Forbidden
      await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${expiredRepToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: `EXPREP_FAIL_${Date.now()}`,
          courseTitle: 'Fail Course',
          department: 'Computer Science',
          level: '300',
          session: '2023/2024',
          semester: 'First Semester',
          examType: 'exam',
          fileName: 'fail.pdf',
          fileUrl: 'http://test.url',
        })
        .expect(403);
    });

    it('active course rep uploads past question with pending status, while lecturer/admin uploads are immediately approved', async () => {
      // 1. Active rep uploads -> status 'pending'
      const repUpload = await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${repToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: `ACT_REP_${Date.now()}`,
          courseTitle: 'Rep Course',
          department: 'Software Engineering',
          level: '300',
          session: '2023/2024',
          semester: 'First Semester',
          examType: 'exam',
          fileName: 'rep.pdf',
          fileUrl: 'http://test.url',
        })
        .expect(201);

      expect(repUpload.body.status).toBe('pending');

      // 2. Lecturer uploads -> status 'approved' immediately
      const lecturerUpload = await request(app.getHttpServer())
        .post('/api/v1/past-questions')
        .set('Authorization', `Bearer ${lecturerToken}`)
        .send({
          courseId: 'dummy-id',
          courseCode: `LECT_APP_${Date.now()}`,
          courseTitle: 'Lecturer Course',
          department: 'Computer Science',
          level: '300',
          session: '2023/2024',
          semester: 'First Semester',
          examType: 'exam',
          fileName: 'lect.pdf',
          fileUrl: 'http://test.url',
        })
        .expect(201);

      expect(lecturerUpload.body.status).toBe('approved');
    });
  });

  // 11. Notice Moderation (Hide / Unhide)
  describe('11. Notice Moderation (Hide and Unhide)', () => {
    it('allows HOD/Admin to hide and unhide notices, and enforces exclusion from standard student lists', async () => {
      // 1. Admin creates notice
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Notice to be Hidden',
          content: 'Secret until moderated',
          category: 'general',
          scope: 'faculty',
        })
        .expect(201);

      const noticeId = createRes.body.id;

      // Notice is visible to student initially
      const list1 = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);
      expect(list1.body.items.some((n: any) => n.id === noticeId)).toBe(true);

      // 2. Admin hides notice
      await request(app.getHttpServer())
        .patch(`/api/v1/notices/${noticeId}/hide`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Under review by Dean' })
        .expect(200);

      // Student NO LONGER sees notice
      const list2 = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);
      expect(list2.body.items.some((n: any) => n.id === noticeId)).toBe(false);

      // Admin STILL sees notice (marked isHidden: true)
      const listAdmin = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const hiddenItem = listAdmin.body.items.find((n: any) => n.id === noticeId);
      expect(hiddenItem).toBeDefined();
      expect(hiddenItem.isHidden).toBe(true);
      expect(hiddenItem.hiddenReason).toBe('Under review by Dean');

      // 3. Admin unhides notice
      await request(app.getHttpServer())
        .patch(`/api/v1/notices/${noticeId}/unhide`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Student sees notice again
      const list3 = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200);
      expect(list3.body.items.some((n: any) => n.id === noticeId)).toBe(true);
    });
  });
});
