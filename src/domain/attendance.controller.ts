import {
  Body,
  Controller,
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
  AdjustAttendanceRecordDto,
  CheckInDto,
  CreateAttendanceSessionDto,
  ManualAttendanceRecordDto,
} from './attendance.dto';
import { AttendanceService } from './attendance.service';

@ApiTags('attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Roles('lecturer', 'hod', 'admin', 'course_rep')
  @Post('sessions')
  createSession(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateAttendanceSessionDto,
  ) {
    return this.attendanceService.createSession(user, dto);
  }

  @Get('sessions')
  listSessions(
    @CurrentUser() user: SafeUser,
    @Query('status') status?: string,
    @Query('offeringId') offeringId?: string,
  ) {
    return this.attendanceService.listSessions(user, { status, offeringId });
  }

  @Get('sessions/open')
  getOpenSessionsForStudent(@CurrentUser() user: SafeUser) {
    return this.attendanceService.getOpenSessionsForStudent(user);
  }

  @Get('sessions/:id')
  getSession(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.attendanceService.getSession(id, user);
  }

  @Get('sessions/:id/live')
  getLiveState(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.attendanceService.getLiveState(id, user);
  }

  @Roles('lecturer', 'hod', 'admin', 'course_rep')
  @Post('sessions/:id/close')
  closeSession(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.attendanceService.closeSession(id, user);
  }

  @Roles('student', 'course_rep')
  @Post('check-in')
  checkIn(
    @CurrentUser() user: SafeUser,
    @Body() dto: CheckInDto,
  ) {
    return this.attendanceService.checkIn(user, dto);
  }

  @Get('sessions/:id/records')
  getSessionRecords(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.attendanceService.getSessionRecords(id, user);
  }

  @Get('sessions/:id/enrolled')
  getEnrolledStudentsForSession(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.attendanceService.getEnrolledStudentsForSession(id, user);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Post('records/manual')
  addManualRecord(
    @CurrentUser() user: SafeUser,
    @Body() dto: ManualAttendanceRecordDto,
  ) {
    return this.attendanceService.addManualRecord(user, dto);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Patch('records/:id/adjust')
  adjustRecord(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: AdjustAttendanceRecordDto,
  ) {
    return this.attendanceService.adjustRecord(id, user, dto);
  }

  @Get('my-history')
  getStudentAttendanceSummaries(@CurrentUser() user: SafeUser) {
    return this.attendanceService.getStudentAttendanceSummaries(user);
  }
}
