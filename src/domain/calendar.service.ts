import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AudienceScope } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { SafeUser } from '../common/user.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAcademicPeriodDto,
  CreateCalendarEventDto,
  CreateTimetableExceptionDto,
  CreateTimetableSlotDto,
  UpdateAcademicPeriodDto,
  UpdateCalendarEventDto,
  UpdateTimetableSlotDto,
} from './calendar.dto';

export interface ExamConflictItem {
  courseCodeA: string;
  courseTitleA: string;
  courseCodeB: string;
  courseTitleB: string;
  startTimeA: string;
  endTimeA: string;
  startTimeB: string;
  endTimeB: string;
  dateStr: string;
  overlapMinutes: number;
  description: string;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Helper to verify if user can manage a timetable slot for an offering.
   */
  async canManageTimetable(user: SafeUser, offeringId: string): Promise<boolean> {
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

    return false;
  }

  // -------------------------------------------------------------------------
  // ACADEMIC PERIODS
  // -------------------------------------------------------------------------

  async getAcademicPeriods() {
    return this.prisma.academicPeriod.findMany({
      orderBy: { start: 'asc' },
    });
  }

  async createAcademicPeriod(user: SafeUser, dto: CreateAcademicPeriodDto) {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only administrators can configure academic periods');
    }

    if (dto.start > dto.end) {
      throw new BadRequestException('Start date must be on or before end date');
    }

    const period = await this.prisma.academicPeriod.create({
      data: {
        sessionId: dto.sessionId,
        title: dto.title,
        type: dto.type,
        start: dto.start,
        end: dto.end,
        notes: dto.notes,
      },
    });

    await this.audit.log(
      user,
      'CREATE_ACADEMIC_PERIOD',
      'academic_period',
      period.id,
      period.title,
      `Added ${period.type} period (${period.start} to ${period.end})`,
    );

    return period;
  }

  async updateAcademicPeriod(id: string, user: SafeUser, dto: UpdateAcademicPeriodDto) {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only administrators can modify academic periods');
    }

    const existing = await this.prisma.academicPeriod.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Academic period not found');
    }

    const start = dto.start || existing.start;
    const end = dto.end || existing.end;
    if (start > end) {
      throw new BadRequestException('Start date must be on or before end date');
    }

    const updated = await this.prisma.academicPeriod.update({
      where: { id },
      data: dto,
    });

    await this.audit.log(
      user,
      'UPDATE_ACADEMIC_PERIOD',
      'academic_period',
      id,
      updated.title,
      'Updated academic period',
    );

    return updated;
  }

  async deleteAcademicPeriod(id: string, user: SafeUser) {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only administrators can delete academic periods');
    }

    const existing = await this.prisma.academicPeriod.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Academic period not found');
    }

    await this.prisma.academicPeriod.delete({ where: { id } });

    await this.audit.log(
      user,
      'DELETE_ACADEMIC_PERIOD',
      'academic_period',
      id,
      existing.title,
      'Deleted academic period',
    );

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // TIMETABLE SLOTS
  // -------------------------------------------------------------------------

  async getTimetableSlots(user: SafeUser, query: { offeringId?: string; onlyMine?: boolean }) {
    const where: any = {};

    if (query.offeringId) {
      where.offeringId = query.offeringId;
    }

    if (query.onlyMine) {
      if (user.role === 'lecturer') {
        where.offering = {
          lecturers: { some: { userId: user.id } },
        };
      } else if (user.role === 'student' || user.role === 'course_rep') {
        where.offering = {
          enrollments: { some: { userId: user.id } },
        };
      }
    }

    const slots = await this.prisma.timetableSlot.findMany({
      where,
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      include: {
        offering: {
          include: { course: true },
        },
        exceptions: true,
      },
    });

    return slots.map((s) => ({
      id: s.id,
      offeringId: s.offeringId,
      courseCode: s.offering.course.code,
      courseTitle: s.offering.course.title,
      weekday: s.weekday,
      startTime: s.startTime,
      endTime: s.endTime,
      venue: s.venue,
      kind: s.kind,
      exceptions: s.exceptions,
    }));
  }

  async createTimetableSlot(user: SafeUser, dto: CreateTimetableSlotDto) {
    const isAuthorized = await this.canManageTimetable(user, dto.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to manage timetable slots for this offering');
    }

    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException('Start time must be before end time');
    }

    const offering = await this.prisma.offering.findUnique({
      where: { id: dto.offeringId },
      include: { course: true },
    });

    if (!offering) {
      throw new NotFoundException('Course offering not found');
    }

    const slot = await this.prisma.timetableSlot.create({
      data: {
        offeringId: dto.offeringId,
        weekday: dto.weekday,
        startTime: dto.startTime,
        endTime: dto.endTime,
        venue: dto.venue,
        kind: dto.kind || 'lecture',
      },
      include: {
        offering: { include: { course: true } },
      },
    });

    await this.audit.log(
      user,
      'CREATE_TIMETABLE_SLOT',
      'timetable_slot',
      slot.id,
      `${offering.course.code} Timetable`,
      `Added weekday ${dto.weekday} slot (${dto.startTime}-${dto.endTime}) at ${dto.venue}`,
    );

    return {
      id: slot.id,
      offeringId: slot.offeringId,
      courseCode: slot.offering.course.code,
      courseTitle: slot.offering.course.title,
      weekday: slot.weekday,
      startTime: slot.startTime,
      endTime: slot.endTime,
      venue: slot.venue,
      kind: slot.kind,
    };
  }

  async updateTimetableSlot(id: string, user: SafeUser, dto: UpdateTimetableSlotDto) {
    const slot = await this.prisma.timetableSlot.findUnique({
      where: { id },
      include: { offering: { include: { course: true } } },
    });

    if (!slot) {
      throw new NotFoundException('Timetable slot not found');
    }

    const isAuthorized = await this.canManageTimetable(user, slot.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to update this timetable slot');
    }

    const startTime = dto.startTime || slot.startTime;
    const endTime = dto.endTime || slot.endTime;
    if (startTime >= endTime) {
      throw new BadRequestException('Start time must be before end time');
    }

    const updated = await this.prisma.timetableSlot.update({
      where: { id },
      data: dto,
      include: { offering: { include: { course: true } } },
    });

    await this.audit.log(
      user,
      'UPDATE_TIMETABLE_SLOT',
      'timetable_slot',
      id,
      `${slot.offering.course.code} Timetable`,
      'Updated timetable slot',
    );

    return {
      id: updated.id,
      offeringId: updated.offeringId,
      courseCode: updated.offering.course.code,
      courseTitle: updated.offering.course.title,
      weekday: updated.weekday,
      startTime: updated.startTime,
      endTime: updated.endTime,
      venue: updated.venue,
      kind: updated.kind,
    };
  }

  async deleteTimetableSlot(id: string, user: SafeUser) {
    const slot = await this.prisma.timetableSlot.findUnique({
      where: { id },
      include: { offering: { include: { course: true } } },
    });

    if (!slot) {
      throw new NotFoundException('Timetable slot not found');
    }

    const isAuthorized = await this.canManageTimetable(user, slot.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to delete this timetable slot');
    }

    await this.prisma.timetableSlot.delete({ where: { id } });

    await this.audit.log(
      user,
      'DELETE_TIMETABLE_SLOT',
      'timetable_slot',
      id,
      `${slot.offering.course.code} Timetable`,
      'Deleted timetable slot',
    );

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // TIMETABLE EXCEPTIONS (Cancelled / Relocated)
  // -------------------------------------------------------------------------

  async getTimetableExceptions(query: { slotId?: string; date?: string }) {
    const where: any = {};
    if (query.slotId) where.slotId = query.slotId;
    if (query.date) where.date = query.date;

    return this.prisma.timetableException.findMany({
      where,
      orderBy: { date: 'asc' },
      include: {
        slot: {
          include: { offering: { include: { course: true } } },
        },
      },
    });
  }

  async createTimetableException(user: SafeUser, dto: CreateTimetableExceptionDto) {
    const slot = await this.prisma.timetableSlot.findUnique({
      where: { id: dto.slotId },
      include: { offering: { include: { course: true } } },
    });

    if (!slot) {
      throw new NotFoundException('Timetable slot not found');
    }

    const isAuthorized = await this.canManageTimetable(user, slot.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to modify exceptions for this slot');
    }

    const exception = await this.prisma.timetableException.create({
      data: {
        slotId: dto.slotId,
        date: dto.date,
        kind: dto.kind,
        newVenue: dto.newVenue,
        newTime: dto.newTime,
        note: dto.note,
        createdBy: user.id,
      },
    });

    await this.audit.log(
      user,
      dto.kind === 'cancelled' ? 'CANCEL_CLASS_SESSION' : 'MOVE_CLASS_SESSION',
      'timetable_exception',
      exception.id,
      `${slot.offering.course.code} (${dto.date})`,
      `${dto.kind.toUpperCase()}: ${dto.note || ''}`,
    );

    return exception;
  }

  async deleteTimetableException(id: string, user: SafeUser) {
    const ex = await this.prisma.timetableException.findUnique({
      where: { id },
      include: { slot: true },
    });

    if (!ex) {
      throw new NotFoundException('Timetable exception not found');
    }

    const isAuthorized = await this.canManageTimetable(user, ex.slot.offeringId);
    if (!isAuthorized) {
      throw new ForbiddenException('You are not authorized to delete this exception');
    }

    await this.prisma.timetableException.delete({ where: { id } });

    await this.audit.log(
      user,
      'DELETE_TIMETABLE_EXCEPTION',
      'timetable_exception',
      id,
      `Exception on ${ex.date}`,
      'Removed schedule exception override',
    );

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // CALENDAR EVENTS & SCOPED VISIBILITY
  // -------------------------------------------------------------------------

  async getCalendarEvents(user: SafeUser, query: { type?: string }) {
    const where: any = {};

    if (query.type) {
      where.type = query.type;
    }

    // Role-based visibility filtering
    if (user.role !== 'admin') {
      const orConditions: any[] = [{ scope: AudienceScope.faculty }];

      // User department
      const userDept = await this.prisma.user.findUnique({
        where: { id: user.id },
        include: { department: true },
      });
      const deptName = userDept?.department?.name;

      if (deptName) {
        orConditions.push({
          scope: AudienceScope.department,
          targetDepartment: deptName,
        });
      }

      if (user.level) {
        orConditions.push({
          scope: AudienceScope.level,
          targetLevel: user.level,
          OR: [{ targetDepartment: null }, { targetDepartment: deptName }],
        });
      }

      // Course-level events for enrolled offerings or taught courses
      const enrolledOfferingIds = await this.prisma.enrollment.findMany({
        where: { userId: user.id },
        select: { offering: { select: { course: { select: { code: true } } } } },
      });
      const enrolledCodes = enrolledOfferingIds.map((e) => e.offering.course.code);

      const teachingOfferingIds = await this.prisma.offeringLecturer.findMany({
        where: { userId: user.id },
        select: { offering: { select: { course: { select: { code: true } } } } },
      });
      const teachingCodes = teachingOfferingIds.map((t) => t.offering.course.code);

      const relevantCourseCodes = Array.from(new Set([...enrolledCodes, ...teachingCodes]));
      if (relevantCourseCodes.length > 0) {
        orConditions.push({
          scope: AudienceScope.course,
          courseCode: { in: relevantCourseCodes },
        });
      }

      where.OR = orConditions;
    }

    const events = await this.prisma.calendarEvent.findMany({
      where,
      orderBy: { start: 'asc' },
      include: {
        creator: true,
      },
    });

    return events.map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      allDay: e.allDay,
      location: e.location || undefined,
      courseId: e.courseId || undefined,
      courseCode: e.courseCode || undefined,
      scope: e.scope,
      targetDepartment: e.targetDepartment || undefined,
      targetLevel: e.targetLevel ? `${e.targetLevel}` : undefined,
      createdBy: e.createdBy,
      createdByName: e.creator?.fullName,
    }));
  }

  async createCalendarEvent(user: SafeUser, dto: CreateCalendarEventDto) {
    if (user.role === 'student') {
      throw new ForbiddenException('Students cannot create calendar events');
    }

    const start = new Date(dto.start);
    const end = new Date(dto.end);
    if (start >= end) {
      throw new BadRequestException('Event start time must be strictly before end time');
    }

    // Scoping permissions check
    if (user.role === 'hod' && dto.scope === AudienceScope.department) {
      const userDept = await this.prisma.user.findUnique({
        where: { id: user.id },
        include: { department: true },
      });
      if (dto.targetDepartment && dto.targetDepartment !== userDept?.department?.name) {
        throw new ForbiddenException('HOD can only create events for their own department');
      }
    }

    const event = await this.prisma.calendarEvent.create({
      data: {
        title: dto.title,
        type: dto.type,
        start,
        end,
        allDay: dto.allDay || false,
        location: dto.location,
        courseId: dto.courseId,
        courseCode: dto.courseCode,
        scope: dto.scope || AudienceScope.faculty,
        targetDepartment: dto.targetDepartment,
        targetLevel: dto.targetLevel,
        createdBy: user.id,
      },
      include: { creator: true },
    });

    await this.audit.log(
      user,
      'CREATE_CALENDAR_EVENT',
      'calendar_event',
      event.id,
      event.title,
      `Created ${event.type} event scheduled for ${event.start.toISOString()}`,
    );

    return {
      id: event.id,
      title: event.title,
      type: event.type,
      start: event.start.toISOString(),
      end: event.end.toISOString(),
      allDay: event.allDay,
      location: event.location || undefined,
      courseId: event.courseId || undefined,
      courseCode: event.courseCode || undefined,
      scope: event.scope,
      targetDepartment: event.targetDepartment || undefined,
      targetLevel: event.targetLevel ? `${event.targetLevel}` : undefined,
      createdBy: event.createdBy,
      createdByName: event.creator?.fullName,
    };
  }

  async updateCalendarEvent(id: string, user: SafeUser, dto: UpdateCalendarEventDto) {
    const existing = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Calendar event not found');
    }

    if (user.role !== 'admin' && existing.createdBy !== user.id) {
      throw new ForbiddenException('You can only edit events created by yourself');
    }

    const start = dto.start ? new Date(dto.start) : existing.start;
    const end = dto.end ? new Date(dto.end) : existing.end;
    if (start >= end) {
      throw new BadRequestException('Event start time must be strictly before end time');
    }

    const updated = await this.prisma.calendarEvent.update({
      where: { id },
      data: {
        title: dto.title,
        type: dto.type,
        start,
        end,
        allDay: dto.allDay,
        location: dto.location,
        courseCode: dto.courseCode,
        scope: dto.scope,
        targetDepartment: dto.targetDepartment,
        targetLevel: dto.targetLevel,
      },
      include: { creator: true },
    });

    await this.audit.log(
      user,
      'UPDATE_CALENDAR_EVENT',
      'calendar_event',
      id,
      updated.title,
      'Updated calendar event',
    );

    return {
      id: updated.id,
      title: updated.title,
      type: updated.type,
      start: updated.start.toISOString(),
      end: updated.end.toISOString(),
      allDay: updated.allDay,
      location: updated.location || undefined,
      courseCode: updated.courseCode || undefined,
      scope: updated.scope,
      targetDepartment: updated.targetDepartment || undefined,
      targetLevel: updated.targetLevel ? `${updated.targetLevel}` : undefined,
      createdBy: updated.createdBy,
      createdByName: updated.creator?.fullName,
    };
  }

  async deleteCalendarEvent(id: string, user: SafeUser) {
    const existing = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Calendar event not found');
    }

    if (user.role !== 'admin' && existing.createdBy !== user.id) {
      throw new ForbiddenException('You can only delete events created by yourself');
    }

    await this.prisma.calendarEvent.delete({ where: { id } });

    await this.audit.log(
      user,
      'DELETE_CALENDAR_EVENT',
      'calendar_event',
      id,
      existing.title,
      'Deleted calendar event',
    );

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // TIMETABLE & EXAMINATION CONFLICT DETECTION
  // -------------------------------------------------------------------------

  /**
   * Reusable conflict-detection utility comparing a student's enrolled courses
   * against published examination timetable slots/events.
   */
  async detectExamConflicts(user: SafeUser): Promise<{
    conflicts: ExamConflictItem[];
    totalConflicts: number;
    enrolledCoursesChecked: string[];
  }> {
    // 1. Fetch student's enrolled courses
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId: user.id },
      include: {
        offering: {
          include: { course: true },
        },
      },
    });

    const enrolledCourses = enrollments.map((enr) => ({
      offeringId: enr.offeringId,
      code: enr.offering.course.code.trim().toUpperCase(),
      title: enr.offering.course.title,
    }));

    const enrolledCodes = enrolledCourses.map((c) => c.code);

    if (enrolledCodes.length < 2) {
      return { conflicts: [], totalConflicts: 0, enrolledCoursesChecked: enrolledCodes };
    }

    // 2. Fetch all scheduled exam events for these courses
    const examEvents = await this.prisma.calendarEvent.findMany({
      where: {
        type: 'exam',
        courseCode: { in: enrolledCodes },
      },
      orderBy: { start: 'asc' },
    });

    const conflicts: ExamConflictItem[] = [];

    // 3. Compare each pair of scheduled exams
    for (let i = 0; i < examEvents.length; i++) {
      for (let j = i + 1; j < examEvents.length; j++) {
        const a = examEvents[i];
        const b = examEvents[j];

        // Only compare different courses
        if (a.courseCode === b.courseCode) continue;

        const aStart = a.start.getTime();
        const aEnd = a.end.getTime();
        const bStart = b.start.getTime();
        const bEnd = b.end.getTime();

        // Check if there is an overlap: aStart < bEnd && aEnd > bStart
        if (aStart < bEnd && aEnd > bStart) {
          const overlapStart = Math.max(aStart, bStart);
          const overlapEnd = Math.min(aEnd, bEnd);
          const overlapMinutes = Math.round((overlapEnd - overlapStart) / 60000);

          const courseA = enrolledCourses.find((c) => c.code === a.courseCode);
          const courseB = enrolledCourses.find((c) => c.code === b.courseCode);

          const dateStr = a.start.toISOString().split('T')[0];

          conflicts.push({
            courseCodeA: a.courseCode || '',
            courseTitleA: courseA?.title || a.title,
            courseCodeB: b.courseCode || '',
            courseTitleB: courseB?.title || b.title,
            startTimeA: a.start.toISOString(),
            endTimeA: a.end.toISOString(),
            startTimeB: b.start.toISOString(),
            endTimeB: b.end.toISOString(),
            dateStr,
            overlapMinutes,
            description: `Examination collision on ${dateStr}: ${a.courseCode} overlaps with ${b.courseCode} by ${overlapMinutes} minutes`,
          });
        }
      }
    }

    return {
      conflicts,
      totalConflicts: conflicts.length,
      enrolledCoursesChecked: enrolledCodes,
    };
  }
}
