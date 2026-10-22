import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators';
import { SafeUser } from '../common/user.util';
import { OnboardingService } from './onboarding.service';
import {
  ApplyOnboardingDto,
  BulkImportAdmissionsRosterDto,
  ConvertApplicationDto,
  QueryApplicationsDto,
  ResolveExceptionDto,
  ReviewApplicationDto,
  StudentOnboardSubmitDto,
  TrackOnboardingDto,
  UpdateRegistrationGuideDto,
  UploadOnboardingDocDto,
} from './onboarding.dto';
import { Role } from '@prisma/client';

@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /**
   * Helper to resolve candidate application from request headers/tokens.
   */
  private extractCandidateToken(req: Request): string {
    const customHeader = req.headers['x-onboarding-token'];
    if (typeof customHeader === 'string' && customHeader.trim()) {
      return customHeader.trim();
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const queryToken = req.query?.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      return queryToken.trim();
    }
    throw new BadRequestException(
      'Missing candidate authentication token (x-onboarding-token header)',
    );
  }

  // --------------------------------------------------------------------------
  // CANDIDATE WORKFLOW ENDPOINTS (PUBLIC / CANDIDATE SCOPE)
  // --------------------------------------------------------------------------

  @Public()
  @Post('apply')
  apply(@Body() dto: ApplyOnboardingDto) {
    return this.onboarding.createApplication(dto);
  }

  @Public()
  @Post('track')
  track(@Body() dto: TrackOnboardingDto) {
    return this.onboarding.trackApplication(dto);
  }

  @Public()
  @Get('my-application')
  async getMyApplication(
    @Req() req: Request,
    @Query('applicationId') queryAppId?: string,
  ) {
    const rawToken = this.extractCandidateToken(req);
    const appId = queryAppId || ((req as any).user as any)?.applicationId || ((req as any).user as any)?.id;
    const validatedApp = await this.onboarding.validateCandidateAccess(
      appId || rawToken,
      rawToken,
    );
    return this.onboarding.getMyApplication(validatedApp.id);
  }

  @Public()
  @Post('my-application/documents')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @Req() req: Request,
    @Body() dto: UploadOnboardingDocDto,
    @UploadedFile() file: Express.Multer.File,
    @Query('applicationId') queryAppId?: string,
  ) {
    const rawToken = this.extractCandidateToken(req);
    const appId = queryAppId || ((req as any).user as any)?.applicationId || ((req as any).user as any)?.id;
    const validatedApp = await this.onboarding.validateCandidateAccess(
      appId || rawToken,
      rawToken,
    );
    return this.onboarding.uploadDocument(
      validatedApp.id,
      dto.documentType,
      file,
      dto.title,
    );
  }

  @Public()
  @Post('my-application/submit')
  async submitApplication(
    @Req() req: Request,
    @Query('applicationId') queryAppId?: string,
  ) {
    const rawToken = this.extractCandidateToken(req);
    const appId = queryAppId || ((req as any).user as any)?.applicationId || ((req as any).user as any)?.id;
    const validatedApp = await this.onboarding.validateCandidateAccess(
      appId || rawToken,
      rawToken,
    );
    return this.onboarding.submitApplication(validatedApp.id);
  }

  @Public()
  @Get('guide')
  getRegistrationGuide(
    @Query('session') session?: string,
    @Query('department') department?: string,
  ) {
    return this.onboarding.getRegistrationGuide(session, department);
  }

  @Public()
  @Get('departments')
  getDepartments() {
    return this.onboarding.getDepartments();
  }

  @Public()
  @Get('documents/:id/view')
  async viewDocument(
    @Param('id') docId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Resolve caller identity: either staff via req.user or candidate via token
    let caller: any = (req as any).user;
    if (!caller) {
      try {
        const rawToken = this.extractCandidateToken(req);
        // Candidate token could match sub
        caller = { applicationId: rawToken };
      } catch {
        // No caller
      }
    }

    const doc = await this.onboarding.streamDocument(caller, docId);
    const safeFilename = encodeURIComponent(doc.fileName).replace(
      /['()]/g,
      escape,
    );

    res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', doc.sizeBytes);
    res.send(doc.buffer);
  }

  // --------------------------------------------------------------------------
  // STAFF & ADMIN SCREENING DECISION ENDPOINTS
  // --------------------------------------------------------------------------

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Get('admin/applications')
  listApplications(
    @CurrentUser() user: SafeUser,
    @Query() query: QueryApplicationsDto,
  ) {
    return this.onboarding.listApplications(user, query);
  }

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Get('admin/applications/:id')
  getApplicationDetails(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
  ) {
    return this.onboarding.getApplicationDetails(user, id);
  }

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Post('admin/applications/:id/review')
  reviewApplication(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ReviewApplicationDto,
  ) {
    return this.onboarding.reviewApplication(user, id, dto);
  }

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Post('admin/applications/:id/convert')
  convertApplication(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ConvertApplicationDto,
  ) {
    return this.onboarding.convertApplicationToMatriculated(user, id, dto);
  }

  @ApiBearerAuth()
  @Roles(Role.admin)
  @Put('admin/guide')
  updateRegistrationGuide(
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateRegistrationGuideDto,
  ) {
    return this.onboarding.updateRegistrationGuide(user, dto);
  }

  // --------------------------------------------------------------------------
  // PHASE 12.4: STUDENT ONBOARDING, ROSTER MATCHING & EXCEPTIONS
  // --------------------------------------------------------------------------

  @Public()
  @Post('submit')
  submitStudentOnboarding(@Body() dto: StudentOnboardSubmitDto) {
    return this.onboarding.submitStudentOnboarding(dto);
  }

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Post('admin/roster/import')
  bulkImportAdmissionsRoster(
    @CurrentUser() user: SafeUser,
    @Body() dto: BulkImportAdmissionsRosterDto,
  ) {
    return this.onboarding.bulkImportAdmissionsRoster(user, dto);
  }

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Get('admin/exceptions')
  listExceptionCases(
    @CurrentUser() user: SafeUser,
    @Query() query: QueryApplicationsDto,
  ) {
    return this.onboarding.listExceptionCases(user, query);
  }

  @ApiBearerAuth()
  @Roles(Role.admin, Role.hod)
  @Post('admin/exceptions/:id/resolve')
  resolveExceptionCase(
    @Param('id') id: string,
    @CurrentUser() user: SafeUser,
    @Body() dto: ResolveExceptionDto,
  ) {
    return this.onboarding.resolveExceptionCase(user, id, dto);
  }
}
