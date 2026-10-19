import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { User, UserStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import {
  BulkStudentImportDto,
  DepartmentDto,
  EnrollmentDto,
  RoleAssignmentDto,
  SettingsDto,
  StatusDto,
  StudentDto,
} from './admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('hod', 'admin')
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('dashboard')
  stats(@CurrentUser() user: User) {
    return this.admin.stats(user);
  }

  @Get('students')
  roster(@CurrentUser() user: User, @Query() query: Record<string, string>) {
    return this.admin.roster(user, query);
  }

  @Post('students')
  student(@CurrentUser() user: User, @Body() dto: StudentDto) {
    return this.admin.upsertStudent(user, dto);
  }

  @Post('students/bulk')
  bulkStudents(
    @CurrentUser() user: User,
    @Body() dto: BulkStudentImportDto,
  ) {
    return this.admin.bulkUpsertStudents(user, dto);
  }

  @Patch('students/:id/status')
  status(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: StatusDto,
  ) {
    return this.admin.status(user, id, dto.status as UserStatus, dto.reason);
  }

  @Get('roles')
  roles() {
    return this.admin.roles();
  }

  @Post('roles')
  assign(@CurrentUser() user: User, @Body() dto: RoleAssignmentDto) {
    return this.admin.assignRole(user, dto);
  }

  @Patch('roles/:id/end')
  endRole(@Param('id') id: string, @CurrentUser() user: User) {
    return this.admin.endRole(user, id);
  }

  @Get('audit-logs')
  audits(@Query() query: Record<string, string>) {
    return this.admin.audits(query);
  }

  @Get('offerings/:id/enrollments')
  enrollments(@Param('id') id: string, @CurrentUser() user: User) {
    return this.admin.offeringEnrollments(user, id);
  }

  @Post('offerings/:id/enrollments')
  enroll(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: EnrollmentDto,
  ) {
    return this.admin.enroll(user, id, dto);
  }

  @Get('settings')
  settings() {
    return this.admin.settings();
  }

  @Roles('admin')
  @Patch('settings')
  settingsUpdate(@CurrentUser() user: User, @Body() dto: SettingsDto) {
    return this.admin.updateSettings(user, dto);
  }

  @Get('departments')
  departments() {
    return this.admin.departments();
  }

  @Roles('admin')
  @Post('departments')
  department(@CurrentUser() user: User, @Body() dto: DepartmentDto) {
    return this.admin.upsertDepartment(user, dto);
  }
}
