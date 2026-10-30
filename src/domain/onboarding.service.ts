import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import {
  DocReviewStatus,
  OnboardingDocType,
  OnboardingStatus,
  Role,
  User,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage.service';
import { MailService } from '../common/mail.service';
import {
  generateObjectKey,
  verifyFileSignature,
} from '../common/file-validator.util';
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
} from './onboarding.dto';
import { AuthService } from '../auth/auth.service';
import { SafeUser } from '../common/user.util';

export const MANDATORY_ONBOARDING_DOCS: OnboardingDocType[] = [
  OnboardingDocType.jamb_result,
  OnboardingDocType.o_level,
  OnboardingDocType.birth_certificate,
  OnboardingDocType.lga_identification,
];

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

const MAX_DOC_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);
  private readonly jwtSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {
    this.jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token.trim()).digest('hex');
  }

  /**
   * Generates a candidate-scoped JWT token for authenticated candidate actions.
   * This token explicitly has role 'candidate' and CANNOT access student/staff routes.
   */
  private generateCandidateToken(applicationId: string, jambRegNo: string): string {
    return this.jwt.sign(
      {
        sub: applicationId,
        jambRegNo,
        role: 'candidate',
        type: 'onboarding_candidate',
      },
      {
        secret: this.jwtSecret,
        expiresIn: '30d',
      },
    );
  }

  /**
   * Validates a candidate access token against the application's accessKeyHash or JWT.
   */
  async validateCandidateAccess(
    applicationId: string,
    rawTokenOrCandidateId: string,
  ): Promise<any> {
    const app = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: { department: true },
    });

    if (!app) {
      throw new NotFoundException('Application not found');
    }

    const hashedInput = this.hashToken(rawTokenOrCandidateId);
    if (hashedInput === app.accessKeyHash) {
      return app;
    }

    // Attempt JWT verification
    try {
      const decoded: any = this.jwt.verify(rawTokenOrCandidateId, {
        secret: this.jwtSecret,
      });
      if (decoded.sub === app.id && decoded.type === 'onboarding_candidate') {
        return app;
      }
    } catch {
      // Ignore JWT failure
    }

    throw new ForbiddenException('Invalid or expired onboarding session');
  }

  /**
   * 1. Candidate Application Initiation
   */
  async createApplication(dto: ApplyOnboardingDto) {
    const normalizedJamb = dto.jambRegNo.trim().toUpperCase();
    const normalizedEmail = dto.email.trim().toLowerCase();
    const session = dto.session.trim();

    // Check department validity (supports ID, uppercase code, or common aliases like dept-ift -> dept-it)
    const deptInput = (dto.departmentId || '').trim();
    const strippedCode = deptInput.replace(/^dept-/, '').toUpperCase();
    const aliasId = deptInput.toLowerCase() === 'dept-ift' ? 'dept-it' : deptInput;
    let department = null;
    if (typeof this.prisma.department.findFirst === 'function') {
      department = await this.prisma.department.findFirst({
        where: {
          OR: [
            { id: deptInput },
            { id: aliasId },
            { code: { equals: strippedCode, mode: 'insensitive' } },
            { code: { equals: deptInput.toUpperCase(), mode: 'insensitive' } },
          ],
        },
      });
    }
    if (!department) {
      department = await this.prisma.department.findUnique({
        where: { id: deptInput },
      });
    }
    if (!department) {
      throw new BadRequestException('Selected department does not exist');
    }

    // Prevent duplicate applications for the same candidate in the same academic session
    const existingApp = await this.prisma.onboardingApplication.findUnique({
      where: {
        jambRegNo_session: {
          jambRegNo: normalizedJamb,
          session,
        },
      },
    });

    if (existingApp) {
      throw new ConflictException(
        `An application already exists for JAMB number ${normalizedJamb} in session ${session}. Use tracking number ${existingApp.applicationNumber} to resume.`,
      );
    }

    // Generate readable tracking number: APP-<YEAR>-<6 HEX>
    const yearPrefix = session.split('/')[0] || new Date().getFullYear().toString();
    const trackingCode = randomBytes(3).toString('hex').toUpperCase();
    const applicationNumber = `APP-${yearPrefix}-${trackingCode}`;

    // Generate random raw access token
    const rawAccessToken = randomBytes(24).toString('hex');
    const accessKeyHash = this.hashToken(rawAccessToken);

    const application = await this.prisma.onboardingApplication.create({
      data: {
        applicationNumber,
        jambRegNo: normalizedJamb,
        fullName: dto.fullName.trim(),
        email: normalizedEmail,
        phone: dto.phone?.trim() || null,
        departmentId: department.id,
        entryLevel: dto.entryLevel || 100,
        session,
        status: OnboardingStatus.draft,
        accessKeyHash,
      },
      include: { department: true },
    });

    // Record creation log
    await this.prisma.onboardingReviewLog.create({
      data: {
        applicationId: application.id,
        fromStatus: OnboardingStatus.draft,
        toStatus: OnboardingStatus.draft,
        action: 'CREATED',
        notes: 'Candidate initiated new onboarding application',
      },
    });

    const candidateToken = this.generateCandidateToken(application.id, normalizedJamb);

    return {
      application: {
        id: application.id,
        applicationNumber: application.applicationNumber,
        jambRegNo: application.jambRegNo,
        fullName: application.fullName,
        email: application.email,
        phone: application.phone,
        department: {
          id: department.id,
          code: department.code,
          name: department.name,
        },
        entryLevel: application.entryLevel,
        session: application.session,
        status: application.status,
        createdAt: application.createdAt,
        documents: [],
        reviewLogs: [
          {
            id: 'init-log',
            fromStatus: OnboardingStatus.draft,
            toStatus: OnboardingStatus.draft,
            action: 'CREATED',
            notes: 'Candidate initiated new onboarding application',
            createdAt: application.createdAt.toISOString(),
          },
        ],
        mandatoryDocTypes: MANDATORY_ONBOARDING_DOCS,
      },
      accessToken: rawAccessToken,
      candidateToken,
    };
  }

  /**
   * 2. Candidate Application Tracking
   */
  async trackApplication(dto: TrackOnboardingDto) {
    const rawIdentifier = (dto.identifier || dto.jambRegNo || '').trim();
    if (!rawIdentifier) {
      throw new BadRequestException(
        'A matching student identifier (JAMB Reg No, Matric No, or Registration Email) is required to track your application.',
      );
    }
    const normalizedIdentifier = rawIdentifier.toUpperCase();
    const normalizedEmail = rawIdentifier.toLowerCase();
    const normalizedAppNum = dto.applicationNumber.trim().toUpperCase();

    const application = await this.prisma.onboardingApplication.findFirst({
      where: {
        applicationNumber: normalizedAppNum,
        OR: [
          { jambRegNo: normalizedIdentifier },
          { email: normalizedEmail },
          { phone: rawIdentifier },
          { convertedMatricNo: normalizedIdentifier },
        ],
      },
      include: {
        department: true,
        documents: {
          select: {
            id: true,
            documentType: true,
            title: true,
            fileName: true,
            sizeBytes: true,
            status: true,
            reviewNotes: true,
            reviewedAt: true,
            createdAt: true,
          },
        },
        reviewLogs: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            action: true,
            notes: true,
            createdAt: true,
          },
        },
      },
    });

    if (!application) {
      throw new NotFoundException(
        'No matching application record found. Please verify your Application Reference Number and Student Identifier.',
      );
    }

    const candidateToken = this.generateCandidateToken(application.id, application.jambRegNo);

    return {
      application: {
        id: application.id,
        applicationNumber: application.applicationNumber,
        jambRegNo: application.jambRegNo,
        fullName: application.fullName,
        email: application.email,
        phone: application.phone,
        department: {
          id: application.department.id,
          code: application.department.code,
          name: application.department.name,
        },
        entryLevel: application.entryLevel,
        session: application.session,
        status: application.status,
        actionRequiredReason: application.actionRequiredReason,
        rejectionReason: application.rejectionReason,
        convertedMatricNo: application.convertedMatricNo,
        convertedAt: application.convertedAt,
        createdAt: application.createdAt,
        updatedAt: application.updatedAt,
        documents: application.documents,
        reviewLogs: application.reviewLogs,
      },
      candidateToken,
    };
  }

  /**
   * 3. Get Current Candidate's Application details
   */
  async getMyApplication(applicationId: string) {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: {
        department: true,
        documents: {
          select: {
            id: true,
            documentType: true,
            title: true,
            fileName: true,
            sizeBytes: true,
            status: true,
            reviewNotes: true,
            reviewedAt: true,
            createdAt: true,
          },
        },
        reviewLogs: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            action: true,
            notes: true,
            createdAt: true,
          },
        },
      },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    return {
      id: application.id,
      applicationNumber: application.applicationNumber,
      jambRegNo: application.jambRegNo,
      fullName: application.fullName,
      email: application.email,
      phone: application.phone,
      department: {
        id: application.department.id,
        code: application.department.code,
        name: application.department.name,
      },
      entryLevel: application.entryLevel,
      session: application.session,
      status: application.status,
      actionRequiredReason: application.actionRequiredReason,
      rejectionReason: application.rejectionReason,
      convertedMatricNo: application.convertedMatricNo,
      convertedAt: application.convertedAt,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
      documents: application.documents,
      reviewLogs: application.reviewLogs,
      mandatoryDocTypes: MANDATORY_ONBOARDING_DOCS,
    };
  }

  /**
   * 4. Upload Required Document
   */
  async uploadDocument(
    applicationId: string,
    documentType: OnboardingDocType,
    file: Express.Multer.File,
    customTitle?: string,
  ) {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    // Do not allow uploads if application is already verified, rejected, or matriculated
    if (
      application.status === OnboardingStatus.verified ||
      application.status === OnboardingStatus.matriculated ||
      application.status === OnboardingStatus.rejected
    ) {
      throw new BadRequestException(
        `Cannot upload documents while application is in "${application.status}" status.`,
      );
    }

    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Document file buffer is empty');
    }

    if (file.buffer.length > MAX_DOC_SIZE_BYTES) {
      throw new BadRequestException('Document exceeds maximum size limit of 5 MB');
    }

    // Validate file magic bytes signature
    const sigResult = verifyFileSignature(file.buffer, file.originalname, file.mimetype);
    if (!sigResult.valid || !ALLOWED_MIME_TYPES.has(sigResult.detectedMimeType)) {
      throw new BadRequestException(
        sigResult.reason ||
          'Invalid file type. Only PDF, JPEG, and PNG documents are accepted.',
      );
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const fileKey = generateObjectKey(
      'onboarding-docs',
      file.originalname,
      applicationId,
    );

    // Save to underlying storage adapter
    await this.storage.putObject(fileKey, file.buffer, sigResult.detectedMimeType);

    const docTitle =
      customTitle?.trim() ||
      documentType
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

    // Check if document of this type already exists for this application
    const existingDoc = await this.prisma.onboardingDocument.findUnique({
      where: {
        applicationId_documentType: {
          applicationId,
          documentType,
        },
      },
    });

    let savedDoc;
    if (existingDoc) {
      // Clean up previous storage file asynchronously
      this.storage.deleteObject(existingDoc.fileKey).catch(() => {});

      savedDoc = await this.prisma.onboardingDocument.update({
        where: { id: existingDoc.id },
        data: {
          title: docTitle,
          fileKey,
          fileName: file.originalname,
          mimeType: sigResult.detectedMimeType,
          sizeBytes: file.buffer.length,
          sha256,
          status: DocReviewStatus.pending,
          reviewNotes: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      });
    } else {
      savedDoc = await this.prisma.onboardingDocument.create({
        data: {
          applicationId,
          documentType,
          title: docTitle,
          fileKey,
          fileName: file.originalname,
          mimeType: sigResult.detectedMimeType,
          sizeBytes: file.buffer.length,
          sha256,
          status: DocReviewStatus.pending,
        },
      });
    }

    // If application was in 'action_required', check if all required docs exist
    if (application.status === OnboardingStatus.action_required) {
      await this.prisma.onboardingReviewLog.create({
        data: {
          applicationId,
          fromStatus: OnboardingStatus.action_required,
          toStatus: OnboardingStatus.action_required,
          action: 'REVISED_DOCUMENT',
          notes: `Applicant uploaded revised document: ${docTitle}`,
        },
      });
    }

    return {
      id: savedDoc.id,
      documentType: savedDoc.documentType,
      title: savedDoc.title,
      fileName: savedDoc.fileName,
      sizeBytes: savedDoc.sizeBytes,
      status: savedDoc.status,
      updatedAt: savedDoc.updatedAt,
    };
  }

  /**
   * 5. Candidate Submit Application for Screening
   */
  async submitApplication(applicationId: string) {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: { documents: true },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    if (
      application.status !== OnboardingStatus.draft &&
      application.status !== OnboardingStatus.action_required
    ) {
      throw new BadRequestException(
        `Application cannot be submitted from status "${application.status}".`,
      );
    }

    // Verify all mandatory documents are present
    const uploadedTypes = new Set(application.documents.map((d) => d.documentType));
    const missing = MANDATORY_ONBOARDING_DOCS.filter((t) => !uploadedTypes.has(t));

    if (missing.length > 0) {
      const missingLabels = missing
        .map((m) => m.split('_').join(' ').toUpperCase())
        .join(', ');
      throw new BadRequestException(
        `Cannot submit application. Missing required documents: ${missingLabels}.`,
      );
    }

    const fromStatus = application.status;
    const toStatus = OnboardingStatus.submitted;

    const updated = await this.prisma.onboardingApplication.update({
      where: { id: applicationId },
      data: {
        status: toStatus,
        actionRequiredReason: null,
      },
    });

    await this.prisma.onboardingReviewLog.create({
      data: {
        applicationId,
        fromStatus,
        toStatus,
        action: 'SUBMITTED',
        notes: 'Candidate submitted application with all required documents for staff screening',
      },
    });

    return {
      id: updated.id,
      applicationNumber: updated.applicationNumber,
      status: updated.status,
      message: 'Application submitted successfully. Faculty screening will commence shortly.',
    };
  }

  /**
   * 6. Staff List Applications
   */
  async listApplications(reviewer: SafeUser, query: QueryApplicationsDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    // HODs can only view applications for their department
    if (reviewer.role === Role.hod && reviewer.departmentId) {
      where.departmentId = reviewer.departmentId;
    } else if (query.departmentId) {
      where.departmentId = query.departmentId;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.session) {
      where.session = query.session;
    }

    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { jambRegNo: { contains: q, mode: 'insensitive' } },
        { applicationNumber: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.onboardingApplication.count({ where }),
      this.prisma.onboardingApplication.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          department: true,
          documents: {
            select: {
              id: true,
              documentType: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return {
      items: items.map((app) => ({
        id: app.id,
        applicationNumber: app.applicationNumber,
        jambRegNo: app.jambRegNo,
        fullName: app.fullName,
        email: app.email,
        phone: app.phone,
        department: {
          id: app.department.id,
          code: app.department.code,
          name: app.department.name,
        },
        entryLevel: app.entryLevel,
        session: app.session,
        status: app.status,
        convertedMatricNo: app.convertedMatricNo,
        documentsSummary: {
          total: app.documents.length,
          verified: app.documents.filter((d) => d.status === DocReviewStatus.verified).length,
          pending: app.documents.filter((d) => d.status === DocReviewStatus.pending).length,
          rejected: app.documents.filter((d) => d.status === DocReviewStatus.rejected).length,
        },
        createdAt: app.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 7. Staff Get Application Details
   */
  async getApplicationDetails(reviewer: SafeUser, applicationId: string) {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: {
        department: true,
        documents: {
          include: {
            reviewer: {
              select: { id: true, fullName: true, role: true },
            },
          },
        },
        reviewLogs: {
          orderBy: { createdAt: 'desc' },
          include: {
            reviewer: {
              select: { id: true, fullName: true, role: true },
            },
          },
        },
      },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    if (reviewer.role === Role.hod && reviewer.departmentId && reviewer.departmentId !== application.departmentId) {
      throw new ForbiddenException('You can only review applications for your department');
    }

    return application;
  }

  /**
   * 8. Staff Review Application & Step Decisions
   */
  async reviewApplication(
    reviewer: SafeUser,
    applicationId: string,
    dto: ReviewApplicationDto,
  ) {
    const application = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: { documents: true },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    if (reviewer.role === Role.hod && reviewer.departmentId && reviewer.departmentId !== application.departmentId) {
      throw new ForbiddenException('You can only review applications for your department');
    }

    if (application.status === OnboardingStatus.matriculated) {
      throw new BadRequestException('Cannot modify an already matriculated student application');
    }

    const fromStatus = application.status;

    if (dto.action === 'VERIFY_STEP') {
      if (!dto.documentId || !dto.docStatus) {
        throw new BadRequestException('documentId and docStatus are required for VERIFY_STEP');
      }

      const doc = application.documents.find((d) => d.id === dto.documentId);
      if (!doc) {
        throw new NotFoundException('Document not found on this application');
      }

      await this.prisma.onboardingDocument.update({
        where: { id: doc.id },
        data: {
          status: dto.docStatus,
          reviewNotes: dto.notes || null,
          reviewedBy: reviewer.id,
          reviewedAt: new Date(),
        },
      });

      await this.prisma.onboardingReviewLog.create({
        data: {
          applicationId,
          reviewerId: reviewer.id,
          fromStatus,
          toStatus: fromStatus === OnboardingStatus.submitted ? OnboardingStatus.under_review : fromStatus,
          action: 'VERIFY_DOCUMENT',
          notes: `Staff marked ${doc.title} as ${dto.docStatus}. Notes: ${dto.notes || 'None'}`,
        },
      });

      // Update to under_review if currently submitted
      if (fromStatus === OnboardingStatus.submitted) {
        await this.prisma.onboardingApplication.update({
          where: { id: applicationId },
          data: { status: OnboardingStatus.under_review },
        });
      }

      return { success: true, message: `Document marked as ${dto.docStatus}` };
    }

    if (dto.action === 'REQUEST_INFO') {
      if (!dto.reason?.trim()) {
        throw new BadRequestException('Reason is required when requesting additional information');
      }

      const updated = await this.prisma.onboardingApplication.update({
        where: { id: applicationId },
        data: {
          status: OnboardingStatus.action_required,
          actionRequiredReason: dto.reason.trim(),
        },
      });

      await this.prisma.onboardingReviewLog.create({
        data: {
          applicationId,
          reviewerId: reviewer.id,
          fromStatus,
          toStatus: OnboardingStatus.action_required,
          action: 'REQUEST_INFO',
          notes: dto.reason.trim(),
        },
      });

      // Send transactional notification email to applicant
      this.mail
        .sendAccountApprovedNotification(application.email, {
          fullName: application.fullName,
          department: 'Computing',
          role: 'prospective_student',
        })
        .catch(() => {});

      return {
        success: true,
        status: updated.status,
        message: 'Applicant notified of required action',
      };
    }

    if (dto.action === 'REJECT') {
      if (!dto.reason?.trim()) {
        throw new BadRequestException('Reason is required when rejecting an application');
      }

      const updated = await this.prisma.onboardingApplication.update({
        where: { id: applicationId },
        data: {
          status: OnboardingStatus.rejected,
          rejectionReason: dto.reason.trim(),
        },
      });

      await this.prisma.onboardingReviewLog.create({
        data: {
          applicationId,
          reviewerId: reviewer.id,
          fromStatus,
          toStatus: OnboardingStatus.rejected,
          action: 'REJECT',
          notes: dto.reason.trim(),
        },
      });

      return {
        success: true,
        status: updated.status,
        message: 'Application rejected',
      };
    }

    if (dto.action === 'VERIFY_APPLICATION') {
      // Validate that ALL mandatory documents are present and marked 'verified'
      const docMap = new Map(application.documents.map((d) => [d.documentType, d]));
      for (const m of MANDATORY_ONBOARDING_DOCS) {
        const doc = docMap.get(m);
        if (!doc) {
          throw new BadRequestException(
            `Cannot approve application: missing ${m.split('_').join(' ')} document.`,
          );
        }
        if (doc.status !== DocReviewStatus.verified) {
          throw new BadRequestException(
            `Cannot approve application: ${doc.title} must be individually verified first.`,
          );
        }
      }

      const updated = await this.prisma.onboardingApplication.update({
        where: { id: applicationId },
        data: {
          status: OnboardingStatus.verified,
          actionRequiredReason: null,
          rejectionReason: null,
        },
      });

      await this.prisma.onboardingReviewLog.create({
        data: {
          applicationId,
          reviewerId: reviewer.id,
          fromStatus,
          toStatus: OnboardingStatus.verified,
          action: 'APPROVE_VERIFY',
          notes: dto.notes || 'All candidate documents verified. Approved for clearance and matriculation.',
        },
      });

      this.mail
        .sendAccountApprovedNotification(application.email, {
          fullName: application.fullName,
          department: 'Computing',
          role: 'cleared_student',
        })
        .catch(() => {});

      return {
        success: true,
        status: updated.status,
        message: 'Application verified successfully. Candidate is cleared for matriculation.',
      };
    }

    throw new BadRequestException(`Unsupported review action "${dto.action}"`);
  }

  /**
   * 9. Convert Verified Candidate to Official Student on Roster (Transactional)
   */
  async convertApplicationToMatriculated(
    reviewer: SafeUser,
    applicationId: string,
    dto: ConvertApplicationDto,
  ) {
    const normalizedMatric = dto.matricNo.trim().toUpperCase();

    return this.prisma.$transaction(async (tx) => {
      const application = await tx.onboardingApplication.findUnique({
        where: { id: applicationId },
        include: { department: true },
      });

      if (!application) {
        throw new NotFoundException('Application not found');
      }

      if (reviewer.role === Role.hod && reviewer.departmentId && reviewer.departmentId !== application.departmentId) {
        throw new ForbiddenException('You can only convert applications for your department');
      }

      if (application.status !== OnboardingStatus.verified) {
        throw new BadRequestException(
          `Cannot convert application in "${application.status}" status. Application must be "verified" first.`,
        );
      }

      if (application.convertedUserId) {
        throw new ConflictException(
          `Application is already converted to matriculated student account ${application.convertedMatricNo}.`,
        );
      }

      // Check if another active student already has this matric number
      const existingUserWithMatric = await tx.user.findUnique({
        where: { matricNo: normalizedMatric },
      });

      let officialUser: User;

      if (existingUserWithMatric) {
        if (existingUserWithMatric.status === UserStatus.active) {
          throw new ConflictException(
            `Matriculation number ${normalizedMatric} is already assigned to an active student.`,
          );
        }
        // If unactivated user exists on roster, link candidate details
        officialUser = await tx.user.update({
          where: { id: existingUserWithMatric.id },
          data: {
            fullName: application.fullName,
            email: application.email,
            departmentId: application.departmentId,
            level: application.entryLevel,
            status: UserStatus.invited,
          },
        });
      } else {
        // Create new student on official roster
        officialUser = await tx.user.create({
          data: {
            matricNo: normalizedMatric,
            fullName: application.fullName,
            email: application.email,
            role: Role.student,
            departmentId: application.departmentId,
            level: application.entryLevel,
            status: UserStatus.invited,
          },
        });
      }

      // Mark application as matriculated and link official user
      const updatedApp = await tx.onboardingApplication.update({
        where: { id: applicationId },
        data: {
          status: OnboardingStatus.matriculated,
          convertedUserId: officialUser.id,
          convertedMatricNo: normalizedMatric,
          convertedAt: new Date(),
        },
      });

      // Record transaction review log
      await tx.onboardingReviewLog.create({
        data: {
          applicationId,
          reviewerId: reviewer.id,
          fromStatus: OnboardingStatus.verified,
          toStatus: OnboardingStatus.matriculated,
          action: 'CONVERT_MATRIC',
          notes: `Candidate converted to official student record on faculty roster with matriculation number ${normalizedMatric}. Staff: ${reviewer.fullName} (${reviewer.role})`,
        },
      });

      return {
        success: true,
        applicationId: updatedApp.id,
        applicationNumber: updatedApp.applicationNumber,
        status: updatedApp.status,
        convertedStudent: {
          id: officialUser.id,
          matricNo: officialUser.matricNo,
          fullName: officialUser.fullName,
          email: officialUser.email,
          role: officialUser.role,
          status: officialUser.status,
          department: application.department.name,
          level: officialUser.level,
        },
        activationInstructions: `Student account created on faculty roster. Student can now activate their permanent account at /activate using matric number "${normalizedMatric}".`,
      };
    });
  }

  /**
   * 10. Secure Document Streaming & Authorization Check
   */
  async streamDocument(
    caller: { id?: string; role?: string; applicationId?: string; token?: string } | null,
    documentId: string,
  ) {
    const doc = await this.prisma.onboardingDocument.findUnique({
      where: { id: documentId },
      include: {
        application: {
          select: { id: true, jambRegNo: true, departmentId: true },
        },
      },
    });

    if (!doc) {
      throw new NotFoundException('Document not found');
    }

    // Role-based / ownership authorization check:
    // Authorized if:
    // 1) Caller is staff (admin or hod)
    // 2) Caller is the candidate owner (matching candidate applicationId or valid candidate token)
    const isStaff = caller?.role === Role.admin || caller?.role === Role.hod;
    let isOwner = false;

    if (caller?.applicationId && (caller.applicationId === doc.applicationId || caller.id === doc.applicationId)) {
      isOwner = true;
    } else if (caller?.token) {
      try {
        await this.validateCandidateAccess(doc.applicationId, caller.token);
        isOwner = true;
      } catch {
        isOwner = false;
      }
    }

    if (!isStaff && !isOwner) {
      throw new ForbiddenException(
        'You do not have authorization to view or download this candidate document',
      );
    }

    const buffer = await this.storage.getObject(doc.fileKey);

    return {
      buffer,
      mimeType: doc.mimeType,
      fileName: doc.fileName,
      sizeBytes: doc.sizeBytes,
    };
  }

  /**
   * Public list of active departments for candidate onboarding.
   */
  async getDepartments() {
    let list = await this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
      },
    });

    if (!list || list.length === 0) {
      const defaultDepts = [
        { id: 'dept-csc', code: 'CSC', name: 'Computer Science' },
        { id: 'dept-sen', code: 'SEN', name: 'Software Engineering' },
        { id: 'dept-cyb', code: 'CYB', name: 'Cyber Security' },
        { id: 'dept-it', code: 'IFT', name: 'Information Technology' },
      ];
      for (const d of defaultDepts) {
        await this.prisma.department.upsert({
          where: { code: d.code },
          update: { name: d.name },
          create: d,
        });
      }
      list = await this.prisma.department.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
        },
      });
    }

    return list;
  }

  /**
   * 11. Verified Registration & Clearance Guide (Public / Candidate)
   */
  async getRegistrationGuide(session?: string, departmentCode?: string) {
    const currentSession = session || '2025/2026';

    const where: any = {
      isPublished: true,
      session: currentSession,
    };

    if (departmentCode) {
      where.OR = [
        { targetDepartmentCode: departmentCode.toUpperCase() },
        { targetDepartmentCode: null },
      ];
    }

    const guide = await this.prisma.registrationGuide.findFirst({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        publisher: {
          select: { id: true, fullName: true, role: true },
        },
      },
    });

    if (guide) {
      return guide;
    }

    // Return official fallback verified guide
    return {
      id: 'default-guide',
      title: 'Official Faculty of Computing Admission Clearance & Registration Guide',
      session: currentSession,
      targetDepartmentCode: departmentCode || 'ALL',
      importantNotice:
        'IMPORTANT: CODICS is a guided workflow portal and never asks for payment card numbers, PINs, or bank passwords. All payments must be processed directly on the official university portal.',
      steps: [
        {
          order: 1,
          title: 'Acceptance Fee Payment',
          category: 'fees',
          description:
            'Generate your official Remita Retrieval Reference (RRR) on the university central portal and pay your acceptance fee through authorized university banking channels.',
          officialPortalUrl: 'https://waeup.uniben.edu',
          warning:
            'Never pay cash or transfer funds to personal bank accounts. Always verify payments on the official university portal.',
        },
        {
          order: 2,
          title: 'Physical Faculty Clearance & Screening',
          category: 'clearance',
          description:
            'Visit the Faculty of Computing Admissions Screening Center with your original O-level certificate/scratch card, JAMB admission letter, and Local Government identification.',
          officialPortalUrl: undefined,
          warning: 'Clearance is strictly conducted at designated faculty offices.',
        },
        {
          order: 3,
          title: 'Digital Document Upload on CODICS',
          category: 'onboarding',
          description:
            'Upload scanned copies of your screened documents to the CODICS Guided Onboarding portal for review and departmental verification.',
          officialPortalUrl: '/onboarding',
          warning: 'Ensure uploaded scans are clear and readable in PDF or JPEG format.',
        },
        {
          order: 4,
          title: 'Matriculation & Student Account Activation',
          category: 'matriculation',
          description:
            'Once verified by the admissions committee and assigned your official matriculation number, activate your permanent CODICS student account at /activate.',
          officialPortalUrl: '/activate',
          warning: 'Keep your activation code and password confidential.',
        },
      ],
      isPublished: true,
      lastUpdatedDate: new Date(),
      publisher: {
        id: 'system',
        fullName: 'Faculty Admissions Committee',
        role: 'admin',
      },
    };
  }

  /**
   * 12. Staff Publish / Update Registration Guide
   */
  async updateRegistrationGuide(
    publisher: SafeUser,
    dto: UpdateRegistrationGuideDto,
  ) {
    const existing = await this.prisma.registrationGuide.findFirst({
      where: {
        session: dto.session,
        targetDepartmentCode: dto.targetDepartmentCode || null,
      },
    });

    if (existing) {
      return this.prisma.registrationGuide.update({
        where: { id: existing.id },
        data: {
          title: dto.title.trim(),
          steps: dto.steps as any,
          importantNotice: dto.importantNotice?.trim() || null,
          isPublished: dto.isPublished ?? true,
          publishedBy: publisher.id,
          lastUpdatedDate: new Date(),
        },
      });
    }

    return this.prisma.registrationGuide.create({
      data: {
        title: dto.title.trim(),
        session: dto.session,
        targetDepartmentCode: dto.targetDepartmentCode || null,
        steps: dto.steps as any,
        importantNotice: dto.importantNotice?.trim() || null,
        isPublished: dto.isPublished ?? true,
        publishedBy: publisher.id,
        lastUpdatedDate: new Date(),
      },
    });
  }

  // ==========================================================================
  // PHASE 12.4: STUDENT ONBOARDING, ADMISSIONS ROSTER MATCHING & EXCEPTIONS
  // ==========================================================================

  /**
   * Bulk imports and validates admissions roster records.
   * Authorized strictly for Admin and HOD (HOD restricted to their department).
   */
  async bulkImportAdmissionsRoster(
    actor: SafeUser,
    dto: BulkImportAdmissionsRosterDto,
  ) {
    const summary = {
      total: dto.records.length,
      imported: 0,
      updated: 0,
      skippedDuplicates: 0,
      invalid: 0,
      errors: [] as { row: number; identifier: string; reason: string }[],
      dryRun: Boolean(dto.dryRun),
    };

    const departments = await this.prisma.department.findMany({
      select: { id: true, code: true },
    });
    const deptCodeMap = new Map(departments.map((d) => [d.code.toUpperCase(), d.id]));

    // Check HOD department scope
    let allowedDeptCode: string | null = null;
    if (actor.role === Role.hod && actor.departmentId) {
      const hodDept = departments.find((d) => d.id === actor.departmentId);
      if (hodDept) allowedDeptCode = hodDept.code.toUpperCase();
    }

    const seenJambs = new Set<string>();

    for (let i = 0; i < dto.records.length; i++) {
      const item = dto.records[i];
      const rowNum = i + 1;
      const jambRegNo = item.jambRegNo?.trim().toUpperCase();
      const matricNo = item.matricNo?.trim().toUpperCase() || null;
      const deptCode = item.departmentCode?.trim().toUpperCase();

      if (!jambRegNo) {
        summary.invalid++;
        summary.errors.push({ row: rowNum, identifier: 'UNKNOWN', reason: 'Missing JAMB registration number' });
        continue;
      }

      if (!deptCode || !deptCodeMap.has(deptCode)) {
        summary.invalid++;
        summary.errors.push({ row: rowNum, identifier: jambRegNo, reason: `Unrecognized department code: ${deptCode}` });
        continue;
      }

      if (actor.role === Role.hod && allowedDeptCode && deptCode !== allowedDeptCode) {
        summary.invalid++;
        summary.errors.push({
          row: rowNum,
          identifier: jambRegNo,
          reason: `HOD cannot import roster records for another department (${deptCode})`,
        });
        continue;
      }

      if (seenJambs.has(jambRegNo)) {
        summary.skippedDuplicates++;
        summary.errors.push({ row: rowNum, identifier: jambRegNo, reason: 'Duplicate JAMB number within same batch' });
        continue;
      }
      seenJambs.add(jambRegNo);

      if (!dto.dryRun) {
        const existing = await this.prisma.admissionsRoster.findUnique({
          where: { jambRegNo },
        });

        if (existing) {
          if (existing.isClaimed) {
            summary.skippedDuplicates++;
            summary.errors.push({ row: rowNum, identifier: jambRegNo, reason: 'Record has already been claimed by a student' });
            continue;
          }

          await this.prisma.admissionsRoster.update({
            where: { jambRegNo },
            data: {
              fullName: item.fullName.trim(),
              matricNo: matricNo || existing.matricNo,
              email: item.email?.trim().toLowerCase() || existing.email,
              phone: item.phone?.trim() || existing.phone,
              departmentCode: deptCode,
              level: item.level || existing.level,
              session: item.session.trim(),
              verificationKey: item.verificationKey?.trim() ? this.hashToken(item.verificationKey) : existing.verificationKey,
              source: `imported_by_${actor.id}`,
            },
          });
          summary.updated++;
        } else {
          await this.prisma.admissionsRoster.create({
            data: {
              jambRegNo,
              matricNo,
              fullName: item.fullName.trim(),
              email: item.email?.trim().toLowerCase() || null,
              phone: item.phone?.trim() || null,
              departmentCode: deptCode,
              level: item.level || 100,
              session: item.session.trim(),
              verificationKey: item.verificationKey?.trim() ? this.hashToken(item.verificationKey) : this.hashToken('default'),
              source: `imported_by_${actor.id}`,
            },
          });
          summary.imported++;
        }
      } else {
        summary.imported++;
      }
    }

    return summary;
  }

  /**
   * Main student onboarding submission workflow.
   * Matches candidate details against AdmissionsRoster or existing Student Roster.
   * - If confident match: immediately completes onboarding, provisions/links user account, issues tokens.
   * - If uncertain, conflicting, or missing: safely routes to exception queue (OnboardingApplication with status 'under_review' or 'action_required').
   */
  async submitStudentOnboarding(dto: StudentOnboardSubmitDto) {
    const jambNorm = dto.jambRegNo?.trim().toUpperCase();
    const matricNorm = dto.matricNo?.trim().toUpperCase();
    const emailNorm = dto.email?.trim().toLowerCase();
    const deptNorm = dto.departmentCode.trim().toUpperCase();
    const fullName = `${dto.firstName.trim()} ${dto.middleName?.trim() ? dto.middleName.trim() + ' ' : ''}${dto.surname.trim()}`;

    // Validate department existence (with auto-heal for standard faculty departments)
    let department = await this.prisma.department.findFirst({
      where: {
        OR: [{ code: deptNorm }, { name: { equals: deptNorm, mode: 'insensitive' } }],
      },
    });

    if (!department) {
      const KNOWN_FACULTY_DEPTS: Record<string, { id: string; name: string }> = {
        CSC: { id: 'dept-csc', name: 'Computer Science' },
        SEN: { id: 'dept-sen', name: 'Software Engineering' },
        CYB: { id: 'dept-cyb', name: 'Cyber Security' },
        IFT: { id: 'dept-it', name: 'Information Technology' },
      };

      if (KNOWN_FACULTY_DEPTS[deptNorm]) {
        department = await this.prisma.department.upsert({
          where: { code: deptNorm },
          update: { name: KNOWN_FACULTY_DEPTS[deptNorm].name },
          create: {
            id: KNOWN_FACULTY_DEPTS[deptNorm].id,
            code: deptNorm,
            name: KNOWN_FACULTY_DEPTS[deptNorm].name,
          },
        });
      } else {
        throw new BadRequestException(`Department "${dto.departmentCode}" not found`);
      }
    }

    // Step 1: Check if an existing User already has this matricNo or jamb
    if (matricNorm) {
      const existingUserByMatric = await this.prisma.user.findUnique({
        where: { matricNo: matricNorm },
        include: { department: true },
      });

      if (existingUserByMatric) {
        if (existingUserByMatric.status === UserStatus.active) {
          // Account already active! Do NOT create a duplicate or allow unauthorized claim.
          // Route to account recovery/login, or route to exception queue if user claims to be someone else.
          return {
            status: 'CONFLICT_EXISTING_ACCOUNT',
            message: 'An active account already exists with this matriculation number. Please log in or use account recovery.',
            matricNo: matricNorm,
          };
        }

        // Student exists with status 'invited' (pre-seeded on roster)
        // Activate their account with this profile!
        const activated = await this.prisma.user.update({
          where: { id: existingUserByMatric.id },
          data: {
            fullName,
            email: emailNorm || existingUserByMatric.email,
            departmentId: department.id,
            level: dto.level || existingUserByMatric.level || 100,
            status: UserStatus.active,
            activatedAt: new Date(),
            lastLoginAt: new Date(),
          },
          include: { department: true },
        });

        const tokens = await this.auth.issueTokens(activated);
        return {
          status: 'SUCCESS_ONBOARDED',
          message: 'Student account successfully matched and activated from institutional roster',
          user: tokens.user,
          tokens,
        };
      }
    }

    // Step 2: Try to match AdmissionsRoster by jambRegNo or matricNo
    let rosterRecord: any = null;
    try {
      if (jambNorm) {
        rosterRecord = await this.prisma.admissionsRoster.findUnique({
          where: { jambRegNo: jambNorm },
        });
      } else if (matricNorm) {
        rosterRecord = await this.prisma.admissionsRoster.findUnique({
          where: { matricNo: matricNorm },
        });
      }
    } catch (rosterErr: any) {
      this.logger.warn(`Admissions roster lookup query failed: ${rosterErr?.message}`);
      rosterRecord = null;
    }

    // MATCH EVALUATION
    if (rosterRecord) {
      // Invariant: Already claimed record
      if (rosterRecord.isClaimed) {
        return {
          status: 'EXCEPTION_RECORD_ALREADY_CLAIMED',
          message: 'This admission record has already been claimed by another account. A review ticket has been created for faculty administration.',
          applicationNumber: await this.createOrRouteException(dto, department.id, fullName, 'RECORD_ALREADY_CLAIMED'),
        };
      }

      // Department Conflict Detection
      if (rosterRecord.departmentCode !== department.code) {
        return {
          status: 'EXCEPTION_DEPARTMENT_MISMATCH',
          message: `The submitted department (${department.code}) does not match the admitted department (${rosterRecord.departmentCode}). Routed to faculty exception review.`,
          applicationNumber: await this.createOrRouteException(dto, department.id, fullName, 'DEPARTMENT_MISMATCH'),
        };
      }

      // Name Discrepancy Detection: verify that submitted surname or first name matches roster record
      if (rosterRecord.fullName) {
        const rosterTokens = rosterRecord.fullName
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(Boolean);
        const subFirst = dto.firstName.trim().toLowerCase();
        const subSurname = dto.surname.trim().toLowerCase();

        const hasSurnameMatch = rosterTokens.includes(subSurname);
        const hasFirstMatch = rosterTokens.includes(subFirst);

        if (!hasSurnameMatch && !hasFirstMatch) {
          return {
            status: 'EXCEPTION_NAME_MISMATCH',
            message: 'The submitted name does not match the official admissions roster record. Routed to faculty exception review.',
            applicationNumber: await this.createOrRouteException(
              dto,
              department.id,
              fullName,
              'NAME_MISMATCH_WITH_ROSTER',
            ),
          };
        }
      }

      // Dual-factor verification check if verificationKey exists
      if (rosterRecord.verificationKey && rosterRecord.verificationKey !== this.hashToken('default')) {
        if (!dto.verificationSecret || this.hashToken(dto.verificationSecret) !== rosterRecord.verificationKey) {
          return {
            status: 'EXCEPTION_VERIFICATION_MISMATCH',
            message: 'Secondary verification secret did not match admissions record. Routed to faculty exception queue.',
            applicationNumber: await this.createOrRouteException(dto, department.id, fullName, 'VERIFICATION_SECRET_MISMATCH'),
          };
        }
      }

      // SUCCESS: Confident match on AdmissionsRoster!
      // Atomically claim roster entry and provision active student user
      const finalMatric = rosterRecord.matricNo || matricNorm || null;

      const { user } = await this.prisma.$transaction(async (tx) => {
        // Atomic compare-and-swap on admissions record
        const claimResult = await tx.admissionsRoster.updateMany({
          where: { id: rosterRecord.id, isClaimed: false },
          data: { isClaimed: true, claimedAt: new Date() },
        });

        if (claimResult.count === 0) {
          throw new ConflictException('This admission record was claimed concurrently by another process');
        }

        const fallbackEmail = (jambNorm || rosterRecord.jambRegNo).toLowerCase();
        const newUser = await tx.user.create({
          data: {
            fullName,
            email: emailNorm || rosterRecord.email || `${fallbackEmail}@student.foc.edu.ng`,
            matricNo: finalMatric,
            role: Role.student,
            baseRole: Role.student,
            departmentId: department.id,
            level: rosterRecord.level || dto.level || 100,
            status: UserStatus.active,
            activatedAt: new Date(),
            lastLoginAt: new Date(),
          },
          include: { department: true },
        });

        await tx.admissionsRoster.update({
          where: { id: rosterRecord.id },
          data: { claimedByUserId: newUser.id },
        });

        return { user: newUser };
      });

      const tokens = await this.auth.issueTokens(user);
      return {
        status: 'SUCCESS_ONBOARDED',
        message: 'Student record successfully matched against admissions roster. Welcome to CODICS!',
        user: tokens.user,
        tokens,
      };
    }

    // Step 3: No matching record found in admissions roster -> Route to Exception Queue
    const appNumber = await this.createOrRouteException(
      dto,
      department.id,
      fullName,
      'NOT_FOUND_ON_ROSTER',
    );

    return {
      status: 'EXCEPTION_UNMATCHED_RECORD',
      message: 'Your admission record could not be matched automatically. An exception request has been submitted to your department for verification.',
      applicationNumber: appNumber,
    };
  }

  /**
   * Helper to create or update an OnboardingApplication in the exception queue.
   */
  private async createOrRouteException(
    dto: StudentOnboardSubmitDto,
    departmentId: string,
    fullName: string,
    reason: string,
  ): Promise<string> {
    const matricNorm = dto.matricNo?.trim().toUpperCase();
    const jambNorm = dto.jambRegNo?.trim().toUpperCase();
    const jambRegNo = (jambNorm || matricNorm || `APP/${randomBytes(4).toString('hex').toUpperCase()}`).toUpperCase();
    const currentSetting = await this.prisma.setting.findFirst({ orderBy: { updatedAt: 'desc' } });
    const session = currentSetting?.session || '2026/2027';

    const existingApp = await this.prisma.onboardingApplication.findFirst({
      where: { jambRegNo, session },
    });

    if (existingApp) {
      await this.prisma.onboardingApplication.update({
        where: { id: existingApp.id },
        data: {
          fullName,
          phone: dto.phone || existingApp.phone,
          status: OnboardingStatus.under_review,
          actionRequiredReason: `Exception: ${reason}`,
        },
      });
      return existingApp.applicationNumber;
    }

    const appNumber = `FOC-${session.slice(0, 4)}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const newApp = await this.prisma.onboardingApplication.create({
      data: {
        applicationNumber: appNumber,
        jambRegNo,
        fullName,
        email: dto.email?.trim().toLowerCase() || `${jambRegNo.toLowerCase()}@candidate.foc.edu.ng`,
        phone: dto.phone?.trim() || null,
        departmentId,
        entryLevel: dto.level || 100,
        session,
        status: OnboardingStatus.under_review,
        actionRequiredReason: `Exception: ${reason}`,
        accessKeyHash: this.hashToken(randomBytes(16).toString('hex')),
      },
    });

    return newApp.applicationNumber;
  }

  /**
   * Lists exception cases for authorized review (Admin & HOD).
   * Enforces department scoping: HOD can only see cases in their department.
   */
  async listExceptionCases(actor: SafeUser, query: QueryApplicationsDto) {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    const where: any = {};

    // Scoping
    if (actor.role === Role.hod && actor.departmentId) {
      where.departmentId = actor.departmentId;
    } else if (query.departmentId) {
      where.departmentId = query.departmentId;
    }

    if (query.status) {
      where.status = query.status;
    } else {
      // By default list active review exceptions
      where.status = { in: [OnboardingStatus.under_review, OnboardingStatus.action_required] };
    }

    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { fullName: { contains: s, mode: 'insensitive' } },
        { applicationNumber: { contains: s, mode: 'insensitive' } },
        { jambRegNo: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.onboardingApplication.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          department: { select: { id: true, name: true, code: true } },
          documents: { select: { id: true, documentType: true, title: true, status: true } },
        },
      }),
      this.prisma.onboardingApplication.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Resolves an onboarding exception case (APPROVE, REJECT, REQUEST_INFO).
   * Authorized strictly for Admin and HOD.
   */
  async resolveExceptionCase(
    actor: SafeUser,
    applicationId: string,
    dto: ResolveExceptionDto,
  ) {
    const app = await this.prisma.onboardingApplication.findUnique({
      where: { id: applicationId },
      include: { department: true },
    });

    if (!app) {
      throw new NotFoundException('Exception application not found');
    }

    // Scoping enforcement
    if (actor.role === Role.hod && actor.departmentId && app.departmentId !== actor.departmentId) {
      throw new ForbiddenException('HOD can only resolve exception cases within their department');
    }

    if (dto.action === 'APPROVE') {
      const assignedMatric = dto.assignedMatricNo?.trim().toUpperCase() || app.convertedMatricNo || null;

      // Invariant: check if matric is already used
      if (assignedMatric) {
        const existing = await this.prisma.user.findUnique({ where: { matricNo: assignedMatric } });
        if (existing && existing.id !== app.convertedUserId) {
          throw new ConflictException(`Matriculation number ${assignedMatric} is already assigned to another user`);
        }
      }

      return this.prisma.$transaction(async (tx) => {
        // Create or activate student account
        let studentUser = app.convertedUserId
          ? await tx.user.findUnique({ where: { id: app.convertedUserId } })
          : null;

        if (!studentUser) {
          studentUser = await tx.user.create({
            data: {
              fullName: app.fullName,
              email: app.email,
              matricNo: assignedMatric,
              role: Role.student,
              baseRole: Role.student,
              departmentId: app.departmentId,
              level: dto.assignedLevel || app.entryLevel || 100,
              status: UserStatus.active,
              activatedAt: new Date(),
            },
          });
        } else {
          studentUser = await tx.user.update({
            where: { id: studentUser.id },
            data: {
              status: UserStatus.active,
              matricNo: assignedMatric || studentUser.matricNo,
              level: dto.assignedLevel || studentUser.level,
            },
          });
        }

        const updatedApp = await tx.onboardingApplication.update({
          where: { id: app.id },
          data: {
            status: OnboardingStatus.verified,
            convertedUserId: studentUser.id,
            convertedMatricNo: assignedMatric,
            convertedAt: new Date(),
            actionRequiredReason: null,
          },
        });

        await tx.onboardingReviewLog.create({
          data: {
            applicationId: app.id,
            reviewerId: actor.id,
            fromStatus: app.status,
            toStatus: OnboardingStatus.verified,
            action: 'APPROVE_EXCEPTION',
            notes: dto.notes?.trim() || 'Approved by departmental authority',
          },
        });

        return {
          status: 'VERIFIED',
          applicationId: updatedApp.id,
          userId: studentUser.id,
          matricNo: assignedMatric,
        };
      });
    }

    if (dto.action === 'REJECT') {
      const updated = await this.prisma.onboardingApplication.update({
        where: { id: app.id },
        data: {
          status: OnboardingStatus.rejected,
          rejectionReason: dto.notes?.trim() || 'Identity claims could not be verified by faculty administration',
        },
      });

      await this.prisma.onboardingReviewLog.create({
        data: {
          applicationId: app.id,
          reviewerId: actor.id,
          fromStatus: app.status,
          toStatus: OnboardingStatus.rejected,
          action: 'REJECT_EXCEPTION',
          notes: dto.notes?.trim(),
        },
      });

      return { status: 'REJECTED', applicationId: updated.id };
    }

    // REQUEST_INFO
    const updated = await this.prisma.onboardingApplication.update({
      where: { id: app.id },
      data: {
        status: OnboardingStatus.action_required,
        actionRequiredReason: dto.notes?.trim() || 'Additional verification documents required',
      },
    });

    await this.prisma.onboardingReviewLog.create({
      data: {
        applicationId: app.id,
        reviewerId: actor.id,
        fromStatus: app.status,
        toStatus: OnboardingStatus.action_required,
        action: 'REQUEST_ADDITIONAL_INFO',
        notes: dto.notes?.trim(),
      },
    });

    return { status: 'ACTION_REQUIRED', applicationId: updated.id };
  }
}
