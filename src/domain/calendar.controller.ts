import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { SafeUser } from '../common/user.util';
import {
  CreateAcademicPeriodDto,
  CreateCalendarEventDto,
  CreateTimetableExceptionDto,
  CreateTimetableSlotDto,
  UpdateAcademicPeriodDto,
  UpdateCalendarEventDto,
  UpdateTimetableSlotDto,
} from './calendar.dto';
import { CalendarService } from './calendar.service';

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  // -------------------------------------------------------------------------
  // ACADEMIC PERIODS
  // -------------------------------------------------------------------------

  @Get('periods')
  getAcademicPeriods() {
    return this.calendarService.getAcademicPeriods();
  }

  @Roles('admin')
  @Post('periods')
  createAcademicPeriod(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateAcademicPeriodDto,
  ) {
    return this.calendarService.createAcademicPeriod(user, dto);
  }

  @Roles('admin')
  @Patch('periods/:id')
  updateAcademicPeriod(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateAcademicPeriodDto,
  ) {
    return this.calendarService.updateAcademicPeriod(id, user, dto);
  }

  @Roles('admin')
  @Delete('periods/:id')
  deleteAcademicPeriod(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.calendarService.deleteAcademicPeriod(id, user);
  }

  // -------------------------------------------------------------------------
  // TIMETABLE SLOTS
  // -------------------------------------------------------------------------

  @Get('timetable/slots')
  getTimetableSlots(
    @CurrentUser() user: SafeUser,
    @Query('offeringId') offeringId?: string,
    @Query('onlyMine') onlyMine?: string,
  ) {
    return this.calendarService.getTimetableSlots(user, {
      offeringId,
      onlyMine: onlyMine === 'true',
    });
  }

  @Roles('lecturer', 'hod', 'admin')
  @Post('timetable/slots')
  createTimetableSlot(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateTimetableSlotDto,
  ) {
    return this.calendarService.createTimetableSlot(user, dto);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Patch('timetable/slots/:id')
  updateTimetableSlot(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateTimetableSlotDto,
  ) {
    return this.calendarService.updateTimetableSlot(id, user, dto);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Delete('timetable/slots/:id')
  deleteTimetableSlot(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.calendarService.deleteTimetableSlot(id, user);
  }

  // -------------------------------------------------------------------------
  // TIMETABLE EXCEPTIONS
  // -------------------------------------------------------------------------

  @Get('timetable/exceptions')
  getTimetableExceptions(
    @Query('slotId') slotId?: string,
    @Query('date') date?: string,
  ) {
    return this.calendarService.getTimetableExceptions({ slotId, date });
  }

  @Roles('lecturer', 'hod', 'admin')
  @Post('timetable/exceptions')
  createTimetableException(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateTimetableExceptionDto,
  ) {
    return this.calendarService.createTimetableException(user, dto);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Delete('timetable/exceptions/:id')
  deleteTimetableException(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.calendarService.deleteTimetableException(id, user);
  }

  // -------------------------------------------------------------------------
  // CALENDAR EVENTS
  // -------------------------------------------------------------------------

  @Get('events')
  getCalendarEvents(
    @CurrentUser() user: SafeUser,
    @Query('type') type?: string,
  ) {
    return this.calendarService.getCalendarEvents(user, { type });
  }

  @Roles('lecturer', 'hod', 'admin', 'course_rep')
  @Post('events')
  createCalendarEvent(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateCalendarEventDto,
  ) {
    return this.calendarService.createCalendarEvent(user, dto);
  }

  @Roles('lecturer', 'hod', 'admin', 'course_rep')
  @Patch('events/:id')
  updateCalendarEvent(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateCalendarEventDto,
  ) {
    return this.calendarService.updateCalendarEvent(id, user, dto);
  }

  @Roles('lecturer', 'hod', 'admin', 'course_rep')
  @Delete('events/:id')
  deleteCalendarEvent(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.calendarService.deleteCalendarEvent(id, user);
  }

  // -------------------------------------------------------------------------
  // TIMETABLE & EXAM CONFLICTS
  // -------------------------------------------------------------------------

  @Get('conflicts')
  detectExamConflicts(@CurrentUser() user: SafeUser) {
    return this.calendarService.detectExamConflicts(user);
  }
}
