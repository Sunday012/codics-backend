import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AttendanceRecordStatusDto } from './attendance.dto';
import { AttendanceService, generateAttendanceCode } from './attendance.service';

describe('AttendanceService', () => {
  let service: AttendanceService;
  let prisma: any;
  let audit: any;

  const mockAdmin: any = {
    id: 'usr-admin',
    fullName: 'Dean Admin',
    role: 'admin',
    departmentId: null,
  };

  const mockLecturerCs: any = {
    id: 'usr-lecturer-cs',
    fullName: 'Dr. Adeleke',
    role: 'lecturer',
    departmentId: 'dept-cs',
  };

  const mockHodCs: any = {
    id: 'usr-hod-cs',
    fullName: 'Prof. CS HOD',
    role: 'hod',
    departmentId: 'dept-cs',
  };

  const mockHodSe: any = {
    id: 'usr-hod-se',
    fullName: 'Prof. SE HOD',
    role: 'hod',
    departmentId: 'dept-se',
  };

  const mockStudentEnrolled: any = {
    id: 'usr-student-1',
    fullName: 'Amina Bello',
    role: 'student',
    matricNo: 'CSC/2022/084',
    departmentId: 'dept-cs',
  };

  const mockStudentUnenrolled: any = {
    id: 'usr-student-2',
    fullName: 'Ghost Student',
    role: 'student',
    matricNo: 'CSC/2022/999',
    departmentId: 'dept-cs',
  };

  const mockCourseCs = {
    id: 'crs-csc201',
    code: 'CSC 201',
    title: 'Computer Programming I',
    departmentId: 'dept-cs',
  };

  const mockOfferingCs = {
    id: 'off-csc201',
    courseId: 'crs-csc201',
    course: mockCourseCs,
    session: '2025/2026',
    semester: 'first',
  };

  beforeEach(() => {
    prisma = {
      offering: {
        findUnique: jest.fn().mockResolvedValue(mockOfferingCs),
      },
      offeringLecturer: {
        findUnique: jest.fn(),
      },
      enrollment: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      attendanceSession: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      attendanceRecord: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      attendanceAdjustment: {
        create: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn((ops: any) => Promise.all(ops)),
    };

    audit = {
      log: jest.fn(),
    };

    service = new AttendanceService(prisma, audit);
  });

  describe('Authorization Scoping', () => {
    it('allows admin to manage any offering session', async () => {
      const allowed = await service.canManageOffering(mockAdmin, 'off-csc201');
      expect(allowed).toBe(true);
    });

    it('allows HOD to manage offerings in their department and blocks other departments', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);

      const csHodAllowed = await service.canManageOffering(mockHodCs, 'off-csc201');
      expect(csHodAllowed).toBe(true);

      const seHodAllowed = await service.canManageOffering(mockHodSe, 'off-csc201');
      expect(seHodAllowed).toBe(false);
    });

    it('allows assigned lecturer and blocks unassigned lecturer', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.offeringLecturer.findUnique.mockImplementation(({ where }: any) => {
        if (where.offeringId_userId.userId === mockLecturerCs.id) {
          return Promise.resolve({ id: 'ol-1', offeringId: 'off-csc201', userId: mockLecturerCs.id });
        }
        return Promise.resolve(null);
      });

      const assigned = await service.canManageOffering(mockLecturerCs, 'off-csc201');
      expect(assigned).toBe(true);

      const unassigned = await service.canManageOffering(
        { ...mockLecturerCs, id: 'usr-other-lecturer' },
        'off-csc201',
      );
      expect(unassigned).toBe(false);
    });

    it('allows active course rep enrolled in offering and blocks expired rep', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1', offeringId: 'off-csc201', userId: 'usr-rep' });

      const activeRep: any = {
        id: 'usr-rep',
        role: 'course_rep',
        repTermEnd: new Date(Date.now() + 86400000).toISOString(),
      };
      const allowedActive = await service.canManageOffering(activeRep, 'off-csc201');
      expect(allowedActive).toBe(true);

      const expiredRep: any = {
        id: 'usr-rep',
        role: 'course_rep',
        repTermEnd: new Date(Date.now() - 86400000).toISOString(),
      };
      const allowedExpired = await service.canManageOffering(expiredRep, 'off-csc201');
      expect(allowedExpired).toBe(false);
    });
  });

  describe('Session Lifecycle', () => {
    it('creates attendance session and records audit log', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.offeringLecturer.findUnique.mockResolvedValue({ id: 'ol-1' });

      const mockCreatedSession = {
        id: 'sess-123',
        offeringId: 'off-csc201',
        createdBy: mockLecturerCs.id,
        startsAt: new Date(),
        closesAt: new Date(Date.now() + 3600000),
        lateAfterMin: 15,
        rotateSec: 30,
        status: 'open',
        secret: 'test-secret',
        offering: mockOfferingCs,
        creator: mockLecturerCs,
      };
      prisma.attendanceSession.create.mockResolvedValue(mockCreatedSession);

      const result = await service.createSession(mockLecturerCs, {
        offeringId: 'off-csc201',
        lateAfterMin: 15,
        durationMin: 60,
        rotateSec: 30,
      });

      expect(result.id).toBe('sess-123');
      expect(result.courseCode).toBe('CSC 201');
      expect(result.status).toBe('open');
      expect(audit.log).toHaveBeenCalledWith(
        mockLecturerCs,
        'OPEN_ATTENDANCE_SESSION',
        'attendance_session',
        'sess-123',
        'CSC 201 Attendance',
        expect.any(String),
      );
    });

    it('rejects session creation when unauthorized', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.offeringLecturer.findUnique.mockResolvedValue(null);

      await expect(
        service.createSession(mockLecturerCs, { offeringId: 'off-csc201' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('closes session and updates closesAt timestamp', async () => {
      const activeSession = {
        id: 'sess-123',
        offeringId: 'off-csc201',
        status: 'open',
        closesAt: new Date(Date.now() + 3600000),
        offering: mockOfferingCs,
        creator: mockLecturerCs,
      };
      prisma.attendanceSession.findUnique.mockResolvedValue(activeSession);
      prisma.offeringLecturer.findUnique.mockResolvedValue({ id: 'ol-1' });
      prisma.attendanceSession.update.mockResolvedValue({
        ...activeSession,
        status: 'closed',
        closesAt: new Date(),
        startsAt: new Date(),
        lateAfterMin: 15,
        rotateSec: 30,
        secret: 'secret',
      });

      const closed = await service.closeSession('sess-123', mockLecturerCs);
      expect(closed.status).toBe('closed');
      expect(audit.log).toHaveBeenCalledWith(
        mockLecturerCs,
        'CLOSE_ATTENDANCE_SESSION',
        'attendance_session',
        'sess-123',
        'CSC 201 Attendance',
        'Closed attendance session',
      );
    });
  });

  describe('Student Check-In & Code Verification', () => {
    const secret = 'attendance-secret-salt-xyz';
    let openSession: any;

    beforeEach(() => {
      const now = new Date();
      openSession = {
        id: 'sess-active',
        offeringId: 'off-csc201',
        startsAt: now,
        closesAt: new Date(now.getTime() + 3600000), // 1 hour ahead
        lateAfterMin: 15,
        rotateSec: 30,
        status: 'open',
        secret,
        offering: mockOfferingCs,
      };
      prisma.attendanceSession.findUnique.mockResolvedValue(openSession);
    });

    it('rejects check-in if user attempts to check in for another student', async () => {
      await expect(
        service.checkIn(mockStudentEnrolled, {
          sessionId: 'sess-active',
          code: '123456',
          studentId: 'usr-someone-else',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects check-in if session is closed or expired', async () => {
      prisma.attendanceSession.findUnique.mockResolvedValue({
        ...openSession,
        status: 'closed',
      });

      const res = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: '123456',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('session_closed');
    });

    it('rejects check-in if student is not enrolled', async () => {
      prisma.enrollment.findUnique.mockResolvedValue(null);

      const res = await service.checkIn(mockStudentUnenrolled, {
        sessionId: 'sess-active',
        code: '123456',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('not_enrolled');
    });

    it('rejects check-in if student is already checked in', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: 'rec-prior',
        sessionId: 'sess-active',
        studentId: mockStudentEnrolled.id,
        status: 'present',
      });

      const res = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: '123456',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('already_checked_in');
    });

    it('marks student present with valid current TOTP code within grace period', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);

      const currentWindow = Math.floor(Date.now() / 30000);
      const validCode = generateAttendanceCode(secret, currentWindow);

      prisma.attendanceRecord.create.mockResolvedValue({
        id: 'rec-1',
        sessionId: 'sess-active',
        studentId: mockStudentEnrolled.id,
        status: AttendanceRecordStatusDto.PRESENT,
        checkedInAt: new Date(),
        source: 'self',
      });

      const res = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: validCode,
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe(AttendanceRecordStatusDto.PRESENT);
      expect(res.receiptId).toBe('ATT-rec-1');
    });

    it('accepts code from previous window (grace period for network latency)', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);

      const previousWindow = Math.floor(Date.now() / 30000) - 1;
      const graceCode = generateAttendanceCode(secret, previousWindow);

      prisma.attendanceRecord.create.mockResolvedValue({
        id: 'rec-grace',
        sessionId: 'sess-active',
        studentId: mockStudentEnrolled.id,
        status: AttendanceRecordStatusDto.PRESENT,
        checkedInAt: new Date(),
        source: 'self',
      });

      const res = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: graceCode,
      });

      expect(res.success).toBe(true);
      expect(res.receiptId).toBe('ATT-rec-grace');
    });

    it('rejects wrong code and enforces cooldown after 3 wrong attempts', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);

      // Attempt 1: wrong
      const res1 = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: '000000',
      });
      expect(res1.success).toBe(false);
      expect(res1.error).toBe('wrong_code');

      // Attempt 2: wrong
      const res2 = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: '000001',
      });
      expect(res2.success).toBe(false);
      expect(res2.error).toBe('wrong_code');

      // Attempt 3: triggers cooldown
      const res3 = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: '000002',
      });
      expect(res3.success).toBe(false);
      expect(res3.error).toBe('cooling_down');
      expect(res3.cooldownSecondsRemaining).toBe(60);

      // Attempt 4 while cooling down
      const res4 = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: '999999',
      });
      expect(res4.success).toBe(false);
      expect(res4.error).toBe('cooling_down');
    });

    it('identifies expired older code and returns expired_code error', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);

      const olderWindow = Math.floor(Date.now() / 30000) - 3; // 3 windows ago
      const olderCode = generateAttendanceCode(secret, olderWindow);

      const res = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: olderCode,
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('expired_code');
    });

    it('handles concurrent race condition (Prisma P2002) returning already_checked_in', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      prisma.attendanceRecord.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'rec-existing', status: 'present' });

      const currentWindow = Math.floor(Date.now() / 30000);
      const validCode = generateAttendanceCode(secret, currentWindow);

      prisma.attendanceRecord.create.mockRejectedValue({
        code: 'P2002',
        message: 'Unique constraint failed',
      });

      const res = await service.checkIn(mockStudentEnrolled, {
        sessionId: 'sess-active',
        code: validCode,
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('already_checked_in');
    });
  });

  describe('Manual Entries and Review Adjustments', () => {
    it('allows lecturer to add manual record with required reason', async () => {
      prisma.attendanceSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        offeringId: 'off-csc201',
        offering: mockOfferingCs,
      });
      prisma.offeringLecturer.findUnique.mockResolvedValue({ id: 'ol-1' });
      prisma.user.findFirst.mockResolvedValue(mockStudentEnrolled);
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);
      prisma.attendanceRecord.create.mockResolvedValue({
        id: 'rec-manual-1',
        sessionId: 'sess-1',
        studentId: mockStudentEnrolled.id,
        status: 'present',
        checkedInAt: new Date(),
        source: 'manual',
        reason: 'Network disconnect during lecture',
        student: mockStudentEnrolled,
        adjustments: [],
      });

      const record = await service.addManualRecord(mockLecturerCs, {
        sessionId: 'sess-1',
        studentId: mockStudentEnrolled.id,
        status: AttendanceRecordStatusDto.PRESENT,
        reason: 'Network disconnect during lecture',
      });

      expect(record.source).toBe('manual');
      expect(record.reason).toBe('Network disconnect during lecture');
      expect(audit.log).toHaveBeenCalledWith(
        mockLecturerCs,
        'ADD_MANUAL_ATTENDANCE',
        'attendance_record',
        'rec-manual-1',
        expect.stringContaining('Amina Bello'),
        expect.stringContaining('Network disconnect'),
      );
    });

    it('rejects manual entry when reason is empty', async () => {
      await expect(
        service.addManualRecord(mockLecturerCs, {
          sessionId: 'sess-1',
          studentId: mockStudentEnrolled.id,
          status: AttendanceRecordStatusDto.PRESENT,
          reason: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows lecturer to adjust record and logs adjustment history', async () => {
      const existingRecord = {
        id: 'rec-1',
        sessionId: 'sess-1',
        studentId: mockStudentEnrolled.id,
        status: 'absent',
        session: { offeringId: 'off-csc201', offering: mockOfferingCs },
        student: mockStudentEnrolled,
      };
      prisma.attendanceRecord.findUnique.mockResolvedValue(existingRecord);
      prisma.offeringLecturer.findUnique.mockResolvedValue({ id: 'ol-1' });

      prisma.attendanceAdjustment.create.mockResolvedValue({
        id: 'adj-1',
        recordId: 'rec-1',
        fromStatus: 'absent',
        toStatus: 'excused',
        reason: 'Medical certificate submitted',
        adjustedBy: mockLecturerCs.id,
        createdAt: new Date(),
        adjuster: mockLecturerCs,
      });

      prisma.attendanceRecord.update.mockResolvedValue({
        ...existingRecord,
        status: 'excused',
        checkedInAt: new Date(),
        source: 'self',
        adjustments: [
          {
            id: 'adj-1',
            recordId: 'rec-1',
            fromStatus: 'absent',
            toStatus: 'excused',
            reason: 'Medical certificate submitted',
            adjustedBy: mockLecturerCs.id,
            createdAt: new Date(),
            adjuster: mockLecturerCs,
          },
        ],
      });

      const result = await service.adjustRecord('rec-1', mockLecturerCs, {
        toStatus: AttendanceRecordStatusDto.EXCUSED,
        reason: 'Medical certificate submitted',
      });

      expect(result.adjustment.from).toBe('absent');
      expect(result.adjustment.to).toBe('excused');
      expect(result.record.status).toBe('excused');
      expect(audit.log).toHaveBeenCalledWith(
        mockLecturerCs,
        'ADJUST_ATTENDANCE_RECORD',
        'attendance_record',
        'rec-1',
        expect.stringContaining('Amina Bello'),
        expect.stringContaining('Medical certificate'),
      );
    });

    it('blocks student from adjusting an attendance record', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        sessionId: 'sess-1',
        session: { offeringId: 'off-csc201', offering: mockOfferingCs },
      });

      await expect(
        service.adjustRecord('rec-1', mockStudentEnrolled, {
          toStatus: AttendanceRecordStatusDto.PRESENT,
          reason: 'Marking myself present',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
