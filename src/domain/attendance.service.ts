import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { AuditService } from '../common/audit.service';
import { SafeUser } from '../common/user.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdjustAttendanceRecordDto,
  AttendanceRecordStatusDto,
  AttendanceSessionStatusDto,
  CheckInDto,
  CreateAttendanceSessionDto,
  ManualAttendanceRecordDto,
} from './attendance.dto';

const MAX_WRONG_ATTEMPTS = 3;
const COOLDOWN_SECONDS = 60;

/**
 * Derives a deterministic 6-digit rotating code from a secret and window index.
 * Matches client algorithm for synchronization with server authority.
 */
export function generateAttendanceCode(secret: string, windowIndex: number): string {
  let hash = 5381;
  const input = `${secret}:${windowIndex}`;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash |= 0;
  }
  const abs = Math.abs(hash);
  return (abs % 1000000).toString().padStart(6, '0');
}

@Injectable()
export class AttendanceService {
  private wrongAttemptsMap = new Map<string, number>();
  private cooldownUntilMap = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Helper to verify if user can manage attendance for a given offering.
   */
  async canManageOffering(user: SafeUser, offeringId: string): Promise<boolean> {
    if (user.role === 'admin') return true;

    const offering = await this.prisma.offering.findUnique({
      where: { id: offeringId },
      include: { course: true },
    });

    if (!offering) return false;

    if (user.role === 'hod') {
      return Boolean(user.departmentId && offering.course.departmentId === user.departmentId);
    }

    if (user.role === 'lecturer') {
      const assignment = await this.prisma.offeringLecturer.findUnique({
        where: {
          offeringId_userId: {
            offeringId,
            userId: user.id,
          },
        },
      });
      return Boolean(assignment);
    }

    if (user.role === 'course_rep') {
      const isRepActive = user.repTermEnd ? new Date(user.repTermEnd) > new Date() : true;
      if (!isRepActive) return false;

      const enrollment = await this.prisma.enrollment.findUnique({
        where: {
          offeringId_userId: {
            offeringId,
            userId: user.id,
          },
        },
      });
      return Boolean(enrollment);
    }

    return false;
  }

  /**
   * Create and open a new live attendance session.
   */
  async createSession(user: SafeUser, dto: CreateAttendanceSessionDto) {
    const isAuthorized = await this.canManageOffering(user, dto.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to start attendance for this course offering');
    }

    const offering = await this.prisma.offering.findUnique({
      where: { id: dto.offeringId },
      include: { course: true },
    });

    if (!offering) {
      throw new NotFoundException('Course offering not found');
    }

    const durationMin = dto.durationMin || 60;
    const lateAfterMin = dto.lateAfterMin || 15;
    const rotateSec = dto.rotateSec || 30;

    const now = new Date();
    const closesAt = new Date(now.getTime() + durationMin * 60 * 1000);
    const secret = crypto.randomBytes(24).toString('hex');

    const session = await this.prisma.attendanceSession.create({
      data: {
        offeringId: dto.offeringId,
        createdBy: user.id,
        startsAt: now,
        closesAt,
        lateAfterMin,
        rotateSec,
        status: 'open',
        secret,
      },
      include: {
        offering: { include: { course: true } },
        creator: true,
      },
    });

    await this.audit.log(
      user,
      'OPEN_ATTENDANCE_SESSION',
      'attendance_session',
      session.id,
      `${offering.course.code} Attendance`,
      `Opened attendance session with ${lateAfterMin}m late cutoff and ${rotateSec}s code rotation`,
    );

    return this.serializeSession(session, true);
  }

  /**
   * Close an attendance session.
   */
  async closeSession(id: string, user: SafeUser) {
    const session = await this.prisma.attendanceSession.findUnique({
      where: { id },
      include: { offering: { include: { course: true } }, creator: true },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const isAuthorized = await this.canManageOffering(user, session.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to manage this attendance session');
    }

    const now = new Date();
    const updated = await this.prisma.attendanceSession.update({
      where: { id },
      data: {
        status: 'closed',
        closesAt: session.closesAt > now ? now : session.closesAt,
      },
      include: { offering: { include: { course: true } }, creator: true },
    });

    await this.audit.log(
      user,
      'CLOSE_ATTENDANCE_SESSION',
      'attendance_session',
      session.id,
      `${session.offering.course.code} Attendance`,
      'Closed attendance session',
    );

    return this.serializeSession(updated, true);
  }

  /**
   * Get single session by ID.
   */
  async getSession(id: string, user: SafeUser) {
    const session = await this.prisma.attendanceSession.findUnique({
      where: { id },
      include: {
        offering: { include: { course: true } },
        creator: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const canManage = await this.canManageOffering(user, session.offeringId);
    return this.serializeSession(session, canManage);
  }

  /**
   * Live display payload (for projector/screen view).
   */
  async getLiveState(id: string, user: SafeUser) {
    const session = await this.prisma.attendanceSession.findUnique({
      where: { id },
      include: {
        offering: { include: { course: true } },
        creator: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const canManage = await this.canManageOffering(user, session.offeringId);
    if (!canManage) {
      throw new ForbiddenException('Only authorized session managers can view live attendance mode');
    }

    const nowMs = Date.now();
    const windowMs = session.rotateSec * 1000;
    const currentWindow = Math.floor(nowMs / windowMs);
    const msIntoWindow = nowMs % windowMs;
    const secondsRemaining = Math.max(1, Math.ceil((windowMs - msIntoWindow) / 1000));
    const currentCode = generateAttendanceCode(session.secret, currentWindow);

    const checkedInCount = await this.prisma.attendanceRecord.count({
      where: { sessionId: id },
    });

    const recentRecords = await this.prisma.attendanceRecord.findMany({
      where: { sessionId: id },
      orderBy: { checkedInAt: 'desc' },
      take: 5,
      include: { student: true },
    });

    return {
      session: this.serializeSession(session, true),
      currentCode,
      secondsRemaining,
      totalWindowSec: session.rotateSec,
      checkedInCount,
      recentCheckIns: recentRecords.map((r) => ({
        id: r.id,
        studentName: r.student.fullName,
        studentMatric: r.student.matricNo,
        status: r.status,
        checkedInAt: r.checkedInAt.toISOString(),
      })),
    };
  }

  /**
   * List sessions based on user role and filters.
   */
  async listSessions(user: SafeUser, query: { status?: string; offeringId?: string }) {
    const where: any = {};

    if (query.status === 'open' || query.status === 'closed') {
      where.status = query.status;
    }

    if (query.offeringId) {
      where.offeringId = query.offeringId;
    }

    // Role-based visibility
    if (user.role === 'admin') {
      // Admin sees all
    } else if (user.role === 'hod' && user.departmentId) {
      where.offering = {
        course: { departmentId: user.departmentId },
      };
    } else if (user.role === 'lecturer') {
      where.offering = {
        lecturers: { some: { userId: user.id } },
      };
    } else {
      // Student / Course Rep: see sessions for enrolled offerings
      where.offering = {
        enrollments: { some: { userId: user.id } },
      };
    }

    const sessions = await this.prisma.attendanceSession.findMany({
      where,
      orderBy: { startsAt: 'desc' },
      include: {
        offering: { include: { course: true } },
        creator: true,
      },
    });

    return Promise.all(
      sessions.map(async (s) => {
        const canManage = await this.canManageOffering(user, s.offeringId);
        return this.serializeSession(s, canManage);
      }),
    );
  }

  /**
   * List active open sessions for a student.
   */
  async getOpenSessionsForStudent(user: SafeUser) {
    const now = new Date();
    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        status: 'open',
        closesAt: { gt: now },
        offering: {
          enrollments: { some: { userId: user.id } },
        },
      },
      orderBy: { startsAt: 'desc' },
      include: {
        offering: { include: { course: true } },
        creator: true,
      },
    });

    return sessions.map((s) => this.serializeSession(s, false));
  }

  /**
   * Core student check-in with server TOTP verification and unique constraint protection.
   */
  async checkIn(user: SafeUser, dto: CheckInDto) {
    // 1. Verify student identity (cannot check in for others)
    if (dto.studentId && dto.studentId !== user.id) {
      throw new ForbiddenException('You can only check yourself in');
    }

    const session = await this.prisma.attendanceSession.findUnique({
      where: { id: dto.sessionId },
      include: {
        offering: { include: { course: true } },
      },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const now = new Date();
    const nowMs = now.getTime();

    // 2. Check session open/closed state and expiry
    if (session.status === 'closed' || nowMs > session.closesAt.getTime()) {
      return {
        success: false,
        error: 'session_closed',
        message: 'This attendance session is closed.',
      };
    }

    // 3. Verify student enrollment
    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        offeringId_userId: {
          offeringId: session.offeringId,
          userId: user.id,
        },
      },
    });

    if (!enrollment) {
      return {
        success: false,
        error: 'not_enrolled',
        message: `You are not enrolled in ${session.offering.course.code}.`,
      };
    }

    // 4. Check for existing check-in
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: session.id,
          studentId: user.id,
        },
      },
    });

    if (existing) {
      return {
        success: false,
        error: 'already_checked_in',
        message: `You have already checked in to this session (${existing.status.toUpperCase()}).`,
        status: existing.status,
        receiptId: `ATT-${existing.id}`,
      };
    }

    // 5. Check cooldown
    const trackerKey = `${session.id}:${user.id}`;
    const cooldownUntil = this.cooldownUntilMap.get(trackerKey);
    if (cooldownUntil && cooldownUntil > nowMs) {
      const remainingSec = Math.ceil((cooldownUntil - nowMs) / 1000);
      return {
        success: false,
        error: 'cooling_down',
        message: `Too many wrong attempts. Please wait ${remainingSec}s before trying again.`,
        cooldownSecondsRemaining: remainingSec,
      };
    }

    // 6. Server TOTP code verification
    const windowMs = session.rotateSec * 1000;
    const currentWindow = Math.floor(nowMs / windowMs);
    const previousWindow = currentWindow - 1;

    const currentCode = generateAttendanceCode(session.secret, currentWindow);
    const previousCode = generateAttendanceCode(session.secret, previousWindow);

    const inputCode = dto.code.trim();
    const isCurrentMatch = inputCode === currentCode;
    const isPreviousMatch = inputCode === previousCode;

    if (!isCurrentMatch && !isPreviousMatch) {
      const attempts = (this.wrongAttemptsMap.get(trackerKey) || 0) + 1;
      this.wrongAttemptsMap.set(trackerKey, attempts);

      if (attempts >= MAX_WRONG_ATTEMPTS) {
        this.cooldownUntilMap.set(trackerKey, nowMs + COOLDOWN_SECONDS * 1000);
        this.wrongAttemptsMap.delete(trackerKey);
        return {
          success: false,
          error: 'cooling_down',
          message: `Too many wrong attempts. Cooldown active for ${COOLDOWN_SECONDS} seconds.`,
          cooldownSecondsRemaining: COOLDOWN_SECONDS,
        };
      }

      // Check if from older window (grace check for explanation)
      let isOlder = false;
      for (let w = currentWindow - 2; w >= currentWindow - 6; w--) {
        if (inputCode === generateAttendanceCode(session.secret, w)) {
          isOlder = true;
          break;
        }
      }

      const attemptsRemaining = MAX_WRONG_ATTEMPTS - attempts;
      if (isOlder) {
        return {
          success: false,
          error: 'expired_code',
          message: `This attendance code has expired. Please use the current code shown on screen. (${attemptsRemaining} attempt${attemptsRemaining > 1 ? 's' : ''} remaining)`,
          attemptsRemaining,
        };
      }

      return {
        success: false,
        error: 'wrong_code',
        message: `Invalid attendance code. Please check and try again. (${attemptsRemaining} attempt${attemptsRemaining > 1 ? 's' : ''} remaining)`,
        attemptsRemaining,
      };
    }

    // Code matched! Reset failed attempts
    this.wrongAttemptsMap.delete(trackerKey);

    // 7. Calculate status based on late grace period
    const lateCutoffMs = session.startsAt.getTime() + session.lateAfterMin * 60 * 1000;
    const status: AttendanceRecordStatusDto = nowMs <= lateCutoffMs ? AttendanceRecordStatusDto.PRESENT : AttendanceRecordStatusDto.LATE;

    // 8. Insert record protected by database unique constraint
    try {
      const record = await this.prisma.attendanceRecord.create({
        data: {
          sessionId: session.id,
          studentId: user.id,
          status,
          checkedInAt: now,
          source: 'self',
        },
      });

      return {
        success: true,
        status: record.status,
        receiptId: `ATT-${record.id}`,
        courseCode: session.offering.course.code,
        courseTitle: session.offering.course.title,
        checkedInAt: record.checkedInAt.toISOString(),
        message: `You're checked in! Marked as ${record.status.toUpperCase()}.`,
      };
    } catch (err: any) {
      if (err.code === 'P2002') {
        const existingRecord = await this.prisma.attendanceRecord.findUnique({
          where: {
            sessionId_studentId: {
              sessionId: session.id,
              studentId: user.id,
            },
          },
        });
        return {
          success: false,
          error: 'already_checked_in',
          message: `You have already checked in to this session (${existingRecord?.status.toUpperCase() || 'PRESENT'}).`,
          status: existingRecord?.status,
          receiptId: existingRecord ? `ATT-${existingRecord.id}` : undefined,
        };
      }
      throw err;
    }
  }

  /**
   * Get attendance records for a session (Lecturers/Admins/Authorized Reps).
   */
  async getSessionRecords(sessionId: string, user: SafeUser) {
    const session = await this.prisma.attendanceSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const canManage = await this.canManageOffering(user, session.offeringId);
    if (!canManage) {
      throw new ForbiddenException('You are not authorized to view attendance records for this session');
    }

    const records = await this.prisma.attendanceRecord.findMany({
      where: { sessionId },
      orderBy: { checkedInAt: 'desc' },
      include: {
        student: true,
        adjustments: {
          include: { adjuster: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    return records.map((r) => this.serializeRecord(r));
  }

  /**
   * Get enrolled students paired with their attendance record for a session.
   */
  async getEnrolledStudentsForSession(sessionId: string, user: SafeUser) {
    const session = await this.prisma.attendanceSession.findUnique({
      where: { id: sessionId },
      include: { offering: { include: { course: true } } },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const canManage = await this.canManageOffering(user, session.offeringId);
    if (!canManage) {
      throw new ForbiddenException('You are not authorized to view enrolled students for this session');
    }

    // Fetch all enrollments for this offering
    const enrollments = await this.prisma.enrollment.findMany({
      where: { offeringId: session.offeringId },
      include: {
        user: {
          include: { department: true },
        },
      },
      orderBy: { user: { fullName: 'asc' } },
    });

    // Fetch all attendance records for this session
    const records = await this.prisma.attendanceRecord.findMany({
      where: { sessionId },
      include: {
        student: true,
        adjustments: {
          include: { adjuster: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const recordMap = new Map<string, any>();
    records.forEach((r) => {
      recordMap.set(r.studentId, this.serializeRecord(r));
    });

    return enrollments.map((enr) => {
      const studentUser = enr.user;
      return {
        student: {
          id: studentUser.id,
          matricNo: studentUser.matricNo || '',
          name: studentUser.fullName,
          fullName: studentUser.fullName,
          department: studentUser.department?.name || '',
          level: studentUser.level ? `${studentUser.level}` : '',
          email: studentUser.email || '',
        },
        record: recordMap.get(studentUser.id) || undefined,
      };
    });
  }

  /**
   * Add manual attendance record (Lecturer / Admin / Authorized Rep).
   */
  async addManualRecord(user: SafeUser, dto: ManualAttendanceRecordDto) {
    const cleanReason = (dto.reason || '').trim();
    if (!cleanReason) {
      throw new BadRequestException('A reason is required when adding a manual attendance record.');
    }

    const session = await this.prisma.attendanceSession.findUnique({
      where: { id: dto.sessionId },
      include: { offering: { include: { course: true } } },
    });

    if (!session) {
      throw new NotFoundException('Attendance session not found');
    }

    const canManage = await this.canManageOffering(user, session.offeringId);
    if (!canManage) {
      throw new ForbiddenException('You are not authorized to add manual attendance records for this session');
    }

    // Verify student exists
    const student = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: dto.studentId }, { matricNo: dto.studentId }],
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    // Check if record already exists
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: session.id,
          studentId: student.id,
        },
      },
    });

    if (existing) {
      throw new ConflictException(`${student.fullName} already has an attendance record for this session.`);
    }

    const record = await this.prisma.attendanceRecord.create({
      data: {
        sessionId: session.id,
        studentId: student.id,
        status: dto.status,
        checkedInAt: new Date(),
        source: 'manual',
        reason: cleanReason,
      },
      include: {
        student: true,
        adjustments: true,
      },
    });

    await this.audit.log(
      user,
      'ADD_MANUAL_ATTENDANCE',
      'attendance_record',
      record.id,
      `${student.fullName} (${student.matricNo})`,
      `Manually marked ${dto.status.toUpperCase()} for ${session.offering.course.code}: ${cleanReason}`,
    );

    return this.serializeRecord(record);
  }

  /**
   * Adjust attendance record (Lecturer / Admin).
   */
  async adjustRecord(recordId: string, user: SafeUser, dto: AdjustAttendanceRecordDto) {
    const cleanReason = (dto.reason || '').trim();
    if (!cleanReason) {
      throw new BadRequestException('A reason is required when making an attendance adjustment.');
    }

    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: recordId },
      include: {
        session: {
          include: { offering: { include: { course: true } } },
        },
        student: true,
      },
    });

    if (!record) {
      throw new NotFoundException('Attendance record not found');
    }

    const canManage = await this.canManageOffering(user, record.session.offeringId);
    if (!canManage) {
      throw new ForbiddenException('You are not authorized to adjust attendance records for this session');
    }

    const fromStatus = record.status;
    const toStatus = dto.toStatus;

    const [adjustment, updatedRecord] = await this.prisma.$transaction([
      this.prisma.attendanceAdjustment.create({
        data: {
          recordId: record.id,
          fromStatus,
          toStatus,
          reason: cleanReason,
          adjustedBy: user.id,
        },
        include: { adjuster: true },
      }),
      this.prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { status: toStatus },
        include: {
          student: true,
          adjustments: {
            include: { adjuster: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    ]);

    await this.audit.log(
      user,
      'ADJUST_ATTENDANCE_RECORD',
      'attendance_record',
      record.id,
      `${record.student.fullName} (${record.student.matricNo})`,
      `Adjusted attendance from ${fromStatus.toUpperCase()} to ${toStatus.toUpperCase()}: ${cleanReason}`,
    );

    return {
      adjustment: {
        id: adjustment.id,
        recordId: adjustment.recordId,
        from: adjustment.fromStatus,
        to: adjustment.toStatus,
        reason: adjustment.reason,
        by: adjustment.adjustedBy,
        byName: adjustment.adjuster?.fullName || user.fullName,
        at: adjustment.createdAt.toISOString(),
      },
      record: this.serializeRecord(updatedRecord),
    };
  }

  /**
   * Get authenticated student's attendance summary by course.
   */
  async getStudentAttendanceSummaries(user: SafeUser) {
    // 1. Find all offerings the student is enrolled in
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId: user.id },
      include: {
        offering: {
          include: {
            course: true,
            attendanceSessions: {
              orderBy: { startsAt: 'desc' },
            },
          },
        },
      },
    });

    // 2. Fetch all student's attendance records
    const records = await this.prisma.attendanceRecord.findMany({
      where: { studentId: user.id },
    });

    const recordMap = new Map<string, any>();
    records.forEach((r) => {
      recordMap.set(r.sessionId, r);
    });

    return enrollments.map((enr) => {
      const off = enr.offering;
      const sessions = off.attendanceSessions;
      const totalSessions = sessions.length;

      let attendedCount = 0;
      const sessionDetails = sessions.map((sess) => {
        const studentRecord = recordMap.get(sess.id);
        const status = studentRecord ? studentRecord.status : 'absent';
        if (status === 'present' || status === 'late' || status === 'excused') {
          attendedCount++;
        }

        return {
          sessionId: sess.id,
          date: sess.startsAt.toISOString(),
          status,
          checkedInAt: studentRecord?.checkedInAt?.toISOString(),
          source: studentRecord?.source,
        };
      });

      const percentage = totalSessions > 0 ? Math.round((attendedCount / totalSessions) * 100) : 100;

      return {
        courseId: off.course.id,
        courseCode: off.course.code,
        courseTitle: off.course.title,
        totalSessions,
        attendedSessions: attendedCount,
        percentage,
        belowMinimum: percentage < 75,
        sessions: sessionDetails,
      };
    });
  }

  /**
   * Serializes session to frontend-expected shape.
   */
  private serializeSession(session: any, includeSecret = false) {
    return {
      id: session.id,
      offeringId: session.offeringId,
      courseCode: session.offering?.course?.code || '',
      courseTitle: session.offering?.course?.title || '',
      createdBy: session.createdBy,
      createdByName: session.creator?.fullName || '',
      createdByRole: session.creator?.role || '',
      startsAt: session.startsAt.toISOString(),
      closesAt: session.closesAt.toISOString(),
      lateAfterMin: session.lateAfterMin,
      rotateSec: session.rotateSec,
      status: session.status,
      secret: includeSecret ? session.secret : '',
    };
  }

  /**
   * Serializes record to frontend-expected shape.
   */
  private serializeRecord(record: any) {
    return {
      id: record.id,
      sessionId: record.sessionId,
      userId: record.studentId,
      studentName: record.student?.fullName || '',
      studentMatric: record.student?.matricNo || '',
      status: record.status,
      checkedInAt: record.checkedInAt.toISOString(),
      source: record.source,
      reason: record.reason || undefined,
      adjustments: (record.adjustments || []).map((adj: any) => ({
        id: adj.id,
        recordId: adj.recordId,
        from: adj.fromStatus,
        to: adj.toStatus,
        reason: adj.reason,
        by: adj.adjustedBy,
        byName: adj.adjuster?.fullName || '',
        at: adj.createdAt.toISOString(),
      })),
    };
  }
}
