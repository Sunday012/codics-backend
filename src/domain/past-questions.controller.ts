import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { SafeUser } from '../common/user.util';
import {
  ReportPaperDto,
  ReviewPaperDto,
  UploadPaperDto,
} from './past-questions.dto';
import { PastQuestionsService } from './past-questions.service';

@ApiTags('past-questions')
@ApiBearerAuth()
@Controller('past-questions')
export class PastQuestionsController {
  constructor(private readonly papers: PastQuestionsService) {}

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.papers.list(query);
  }

  @Get('pending')
  @Roles('hod', 'admin')
  pending(@CurrentUser() user: SafeUser) {
    return this.papers.pending(user);
  }

  @Get('mine')
  mine(@CurrentUser() user: SafeUser) {
    return this.papers.mine(user);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.papers.get(id);
  }

  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Res() res: Response,
  ) {
    const file = await this.papers.getDownloadFile(id, user);
    const safeFilename = encodeURIComponent(file.fileName).replace(
      /['()]/g,
      escape,
    );
    res.setHeader('Content-Type', file.mimeType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', file.sizeBytes);
    res.send(file.buffer);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: SafeUser,
    @Body() dto: UploadPaperDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.papers.upload(user, dto, file);
  }

  @Roles('hod', 'admin')
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.papers.review(id, user, true);
  }

  @Roles('hod', 'admin')
  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ReviewPaperDto,
  ) {
    return this.papers.review(id, user, false, dto.reason);
  }

  @Post(':id/report')
  report(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ReportPaperDto,
  ) {
    return this.papers.report(id, user, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: SafeUser) {
    return this.papers.remove(id, user);
  }
}
