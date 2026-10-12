import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { User } from '../data/entities';
import { PastQuestionsService } from './past-questions.service';
import { ReportPaperDto, ReviewPaperDto, UploadPaperDto } from './past-questions.dto';

@ApiTags('past-questions') @ApiBearerAuth() @Controller('past-questions')
export class PastQuestionsController {
  constructor(private papers: PastQuestionsService) {}
  @Get() list(@Query() query: Record<string, string>) { return this.papers.list(query); }
  @Get('pending') @Roles('hod', 'admin') pending(@CurrentUser() user: User) { return this.papers.pending(user); }
  @Get('mine') mine(@CurrentUser() user: User) { return this.papers.mine(user); }
  @Get(':id') get(@Param('id') id: string) { return this.papers.get(id); }
  @Post() upload(@CurrentUser() user: User, @Body() dto: UploadPaperDto) { return this.papers.upload(user, dto); }
  @Roles('hod', 'admin') @Post(':id/approve') approve(@Param('id') id: string, @CurrentUser() user: User) { return this.papers.review(id, user, true); }
  @Roles('hod', 'admin') @Post(':id/reject') reject(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: ReviewPaperDto) { return this.papers.review(id, user, false, dto.reason); }
  @Post(':id/report') report(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: ReportPaperDto) { return this.papers.report(id, user, dto); }
  @Delete(':id') remove(@Param('id') id: string, @CurrentUser() user: User) { return this.papers.remove(id, user); }
}
