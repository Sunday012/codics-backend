import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { AudienceScope } from '@prisma/client';

describe('CalendarService', () => {
  let service: CalendarService;
  let prisma: any;
  let audit: any;

  const mockAdmin: any = {
    id: 'usr-admin',
    fullName: 'Admin Florence',
    role: 'admin',
    departmentId: null,
  };

  const mockLecturerCs: any = {
    id: 'usr-lecturer-cs',
    fullName: 'Dr. Adeleke',
    role: 'lecturer',
    departmentId: 'dept-cs',
  };

  const mockLecturerOther: any = {
    id: 'usr-lecturer-other',
    fullName: 'Dr. Other',
    role: 'lecturer',
    departmentId: 'dept-se',
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

  const mockStudent: any = {
    id: 'usr-student',
    fullName: 'Amina Bello',
    role: 'student',
    departmentId: 'dept-cs',
  };

  const mockOfferingCs = {
    id: 'off-csc201',
    courseId: 'crs-csc201',
    lecturerId: 'usr-lecturer-cs',
    course: {
      id: 'crs-csc201',
      code: 'CSC 201',
      title: 'Computer Programming I',
      departmentId: 'dept-cs',
    },
  };

  beforeEach(() => {
    prisma = {
      academicPeriod: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      offering: {
        findUnique: jest.fn(),
      },
      offeringLecturer: {
        findUnique: jest.fn(),
      },
      timetableSlot: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      timetableException: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
      calendarEvent: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      enrollment: {
        findMany: jest.fn(),
      },
      course: {
        findUnique: jest.fn(),
      },
    };

    audit = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new CalendarService(prisma, audit);
  });

  describe('Academic Periods', () => {
    it('allows admin to create an academic period', async () => {
      const dto = {
        sessionId: '2026/2027',
        title: 'Harmattan Semester Lectures',
        type: 'lectures',
        start: '2026-10-01',
        end: '2027-02-28',
      };

      prisma.academicPeriod.create.mockResolvedValue({
        id: 'prd-1',
        ...dto,
      });

      const res = await service.createAcademicPeriod(mockAdmin, dto);
      expect(res.id).toBe('prd-1');
      expect(prisma.academicPeriod.create).toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        mockAdmin,
        'CREATE_ACADEMIC_PERIOD',
        'academic_period',
        'prd-1',
        dto.title,
        'Added lectures period (2026-10-01 to 2027-02-28)',
      );
    });

    it('rejects non-admin users from creating an academic period', async () => {
      const dto = {
        sessionId: '2026/2027',
        title: 'Harmattan',
        type: 'lectures',
        start: '2026-10-01',
        end: '2027-02-28',
      };

      await expect(service.createAcademicPeriod(mockLecturerCs, dto)).rejects.toThrow(ForbiddenException);
      await expect(service.createAcademicPeriod(mockStudent, dto)).rejects.toThrow(ForbiddenException);
    });

    it('rejects academic period with invalid date order (end <= start)', async () => {
      const dto = {
        sessionId: '2026/2027',
        title: 'Invalid Period',
        type: 'lectures',
        start: '2027-02-28',
        end: '2026-10-01',
      };

      await expect(service.createAcademicPeriod(mockAdmin, dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Timetable Slots', () => {
    it('allows assigned lecturer to create a slot for their offering', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.offeringLecturer.findUnique.mockResolvedValue({
        offeringId: 'off-csc201',
        userId: 'usr-lecturer-cs',
      });
      prisma.timetableSlot.create.mockResolvedValue({
        id: 'slot-1',
        offeringId: 'off-csc201',
        weekday: 1,
        startTime: '08:00',
        endTime: '10:00',
        venue: 'Lab 1',
        kind: 'lecture',
        offering: mockOfferingCs,
      });

      const res = await service.createTimetableSlot(mockLecturerCs, {
        offeringId: 'off-csc201',
        weekday: 1,
        startTime: '08:00',
        endTime: '10:00',
        venue: 'Lab 1',
      });

      expect(res.id).toBe('slot-1');
      expect(prisma.timetableSlot.create).toHaveBeenCalled();
    });

    it('allows HOD to create a slot for an offering in their department', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.timetableSlot.create.mockResolvedValue({
        id: 'slot-2',
        offeringId: 'off-csc201',
        weekday: 2,
        startTime: '10:00',
        endTime: '12:00',
        venue: 'LH 2',
        kind: 'lecture',
        offering: mockOfferingCs,
      });

      const res = await service.createTimetableSlot(mockHodCs, {
        offeringId: 'off-csc201',
        weekday: 2,
        startTime: '10:00',
        endTime: '12:00',
        venue: 'LH 2',
      });

      expect(res.id).toBe('slot-2');
    });

    it('rejects unassigned lecturer and foreign HOD from creating slot', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);
      prisma.offeringLecturer.findUnique.mockResolvedValue(null);

      await expect(
        service.createTimetableSlot(mockLecturerOther, {
          offeringId: 'off-csc201',
          weekday: 1,
          startTime: '08:00',
          endTime: '10:00',
          venue: 'Lab 1',
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.createTimetableSlot(mockHodSe, {
          offeringId: 'off-csc201',
          weekday: 1,
          startTime: '08:00',
          endTime: '10:00',
          venue: 'Lab 1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects slot when endTime <= startTime', async () => {
      prisma.offering.findUnique.mockResolvedValue(mockOfferingCs);

      await expect(
        service.createTimetableSlot(mockAdmin, {
          offeringId: 'off-csc201',
          weekday: 1,
          startTime: '10:00',
          endTime: '08:00',
          venue: 'Lab 1',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Calendar Events', () => {
    it('allows admin to create a faculty-wide event', async () => {
      const dto = {
        title: 'Faculty Board Meeting',
        type: 'meeting',
        start: '2026-11-01T10:00:00.000Z',
        end: '2026-11-01T12:00:00.000Z',
        scope: AudienceScope.faculty,
      };

      prisma.calendarEvent.create.mockResolvedValue({
        id: 'evt-1',
        ...dto,
        start: new Date(dto.start),
        end: new Date(dto.end),
      });

      const res = await service.createCalendarEvent(mockAdmin, dto);
      expect(res.id).toBe('evt-1');
      expect(prisma.calendarEvent.create).toHaveBeenCalled();
    });

    it('rejects students from creating faculty-level events', async () => {
      const dto = {
        title: 'Student Unofficial Gathering',
        type: 'event',
        start: '2026-11-01T10:00:00.000Z',
        end: '2026-11-01T12:00:00.000Z',
        scope: AudienceScope.faculty,
      };

      await expect(service.createCalendarEvent(mockStudent, dto)).rejects.toThrow(ForbiddenException);
    });

    it('rejects event creation when end <= start', async () => {
      const dto = {
        title: 'Invalid Event',
        type: 'meeting',
        start: '2026-11-01T12:00:00.000Z',
        end: '2026-11-01T10:00:00.000Z',
        scope: AudienceScope.faculty,
      };

      await expect(service.createCalendarEvent(mockAdmin, dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('detectExamConflicts', () => {
    it('returns empty conflicts when student has no overlapping exams', async () => {
      prisma.enrollment.findMany.mockResolvedValue([
        {
          offeringId: 'off-1',
          offering: {
            courseId: 'crs-csc201',
            course: { id: 'crs-csc201', code: 'CSC 201', title: 'Programming I' },
          },
        },
        {
          offeringId: 'off-2',
          offering: {
            courseId: 'crs-mat201',
            course: { id: 'crs-mat201', code: 'MAT 201', title: 'Calculus' },
          },
        },
      ]);

      prisma.calendarEvent.findMany.mockResolvedValue([
        {
          id: 'exam-1',
          title: 'CSC 201 Examination',
          type: 'exam',
          start: new Date('2026-12-10T09:00:00.000Z'),
          end: new Date('2026-12-10T12:00:00.000Z'),
          location: 'Hall A',
          courseCode: 'CSC 201',
        },
        {
          id: 'exam-2',
          title: 'MAT 201 Examination',
          type: 'exam',
          start: new Date('2026-12-11T09:00:00.000Z'),
          end: new Date('2026-12-11T12:00:00.000Z'),
          location: 'Hall B',
          courseCode: 'MAT 201',
        },
      ]);

      const res = await service.detectExamConflicts(mockStudent);
      expect(res.totalConflicts).toBe(0);
      expect(res.conflicts).toEqual([]);
      expect(res.enrolledCoursesChecked).toEqual(['CSC 201', 'MAT 201']);
    });

    it('detects pairwise interval overlap between distinct enrolled exam slots', async () => {
      prisma.enrollment.findMany.mockResolvedValue([
        {
          offeringId: 'off-1',
          offering: {
            courseId: 'crs-csc201',
            course: { id: 'crs-csc201', code: 'CSC 201', title: 'Programming I' },
          },
        },
        {
          offeringId: 'off-2',
          offering: {
            courseId: 'crs-mat201',
            course: { id: 'crs-mat201', code: 'MAT 201', title: 'Calculus' },
          },
        },
      ]);

      // Both exams scheduled on 2026-12-10 overlapping from 10:00 to 12:00 (120 min overlap)
      prisma.calendarEvent.findMany.mockResolvedValue([
        {
          id: 'exam-csc',
          title: 'CSC 201 Examination',
          type: 'exam',
          start: new Date('2026-12-10T09:00:00.000Z'),
          end: new Date('2026-12-10T12:00:00.000Z'),
          location: 'Lab 1',
          courseCode: 'CSC 201',
        },
        {
          id: 'exam-mat',
          title: 'MAT 201 Examination',
          type: 'exam',
          start: new Date('2026-12-10T10:00:00.000Z'),
          end: new Date('2026-12-10T13:00:00.000Z'),
          location: 'Hall C',
          courseCode: 'MAT 201',
        },
      ]);

      const res = await service.detectExamConflicts(mockStudent);
      expect(res.totalConflicts).toBe(1);
      expect(res.conflicts[0].courseCodeA).toBe('CSC 201');
      expect(res.conflicts[0].courseCodeB).toBe('MAT 201');
      expect(res.conflicts[0].overlapMinutes).toBe(120);
      expect(res.conflicts[0].dateStr).toBe('2026-12-10');
    });

    it('ignores exams for courses the student is NOT enrolled in', async () => {
      // Student is only enrolled in CSC 201
      prisma.enrollment.findMany.mockResolvedValue([
        {
          offeringId: 'off-1',
          offering: {
            courseId: 'crs-csc201',
            course: { id: 'crs-csc201', code: 'CSC 201', title: 'Programming I' },
          },
        },
      ]);

      prisma.calendarEvent.findMany.mockResolvedValue([]);

      const res = await service.detectExamConflicts(mockStudent);
      expect(res.totalConflicts).toBe(0);
      expect(res.conflicts).toEqual([]);
      expect(res.enrolledCoursesChecked).toEqual(['CSC 201']);
    });
  });
});
