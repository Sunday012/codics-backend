import { Body, Controller, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { User } from '../data/entities';
import { AssignmentDto, ExtendDeadlineDto, GradeDto } from './assignments.dto';
import { AssignmentsService } from './assignments.service';

@ApiTags('assignments') @ApiBearerAuth() @Controller()
export class AssignmentsController {
  constructor(private assignments: AssignmentsService) {}
  @Get('assignments') list(@CurrentUser() user: User, @Query() query: Record<string, string>) { return this.assignments.list(user, query); }
  @Get('assignments/:id') get(@Param('id') id: string, @CurrentUser() user: User) { return this.assignments.get(id, user); }
  @Roles('lecturer', 'hod', 'admin') @Post('assignments') create(@CurrentUser() user: User, @Body() dto: AssignmentDto) { return this.assignments.create(user, dto); }
  @Roles('student', 'course_rep') @ApiConsumes('multipart/form-data') @Post('assignments/:id/submissions') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 }, storage: undefined }))
  submit(@Param('id') id: string, @CurrentUser() user: User, @UploadedFile() file: Express.Multer.File) { return this.assignments.submit(id, user, file); }
  @Get('assignments/:id/submissions') submissions(@Param('id') id: string, @CurrentUser() user: User) { return this.assignments.submissions(id, user); }
  @Roles('lecturer', 'hod', 'admin') @Patch('submissions/:id/grade') grade(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: GradeDto) { return this.assignments.grade(id, user, dto); }
  @Roles('lecturer', 'hod', 'admin') @Patch('assignments/:id/deadline') extend(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: ExtendDeadlineDto) { return this.assignments.extend(id, user, dto); }
  @Roles('course_rep', 'lecturer', 'hod', 'admin') @Get('assignments/:id/headcount') headcount(@Param('id') id: string, @CurrentUser() user: User) { return this.assignments.headcount(id, user); }
}
