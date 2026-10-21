import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { SafeUser } from '../common/user.util';
import { AssignmentDto, ExtendDeadlineDto, GradeDto } from './assignments.dto';
import { AssignmentsService } from './assignments.service';

@ApiTags('assignments')
@ApiBearerAuth()
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get('assignments')
  list(@CurrentUser() user: SafeUser, @Query() query: Record<string, string>) {
    return this.assignments.list(user, query);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Get('assignments/teaching/stats')
  teachingStats(@CurrentUser() user: SafeUser) {
    return this.assignments.getLecturerStats(user);
  }

  @Get('assignments/:id')
  get(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.assignments.get(id, user);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Post('assignments')
  create(@CurrentUser() user: SafeUser, @Body() dto: AssignmentDto) {
    return this.assignments.create(user, dto);
  }

  @Roles('student', 'course_rep')
  @ApiConsumes('multipart/form-data')
  @Post('assignments/:id/submissions')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
      storage: undefined,
    }),
  )
  submit(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.assignments.submit(id, user, file);
  }

  @Get('assignments/:id/submissions')
  submissions(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.assignments.submissions(id, user);
  }

  @Get('assignments/:id/submissions/:subId/download')
  async downloadSubmission(
    @Param('id') id: string,
    @Param('subId') subId: string,
    @CurrentUser() user: SafeUser,
    @Res() res: Response,
  ) {
    const file = await this.assignments.getSubmissionFile(id, subId, user);
    const safeFilename = encodeURIComponent(file.fileName).replace(
      /['()]/g,
      escape,
    );
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', file.sizeBytes);
    res.send(file.buffer);
  }

  @Get('submissions/:subId/download')
  async downloadSubmissionDirect(
    @Param('subId') subId: string,
    @CurrentUser() user: SafeUser,
    @Res() res: Response,
  ) {
    const file = await this.assignments.getSubmissionFile('', subId, user);
    const safeFilename = encodeURIComponent(file.fileName).replace(
      /['()]/g,
      escape,
    );
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', file.sizeBytes);
    res.send(file.buffer);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Patch('submissions/:id/grade')
  grade(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: GradeDto,
  ) {
    return this.assignments.grade(id, user, dto);
  }

  @Roles('lecturer', 'hod', 'admin')
  @Patch('assignments/:id/deadline')
  extend(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ExtendDeadlineDto,
  ) {
    return this.assignments.extend(id, user, dto);
  }

  @Roles('course_rep', 'lecturer', 'hod', 'admin')
  @Get('assignments/:id/headcount')
  headcount(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.assignments.headcount(id, user);
  }
}
