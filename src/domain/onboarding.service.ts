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
  ConvertApplicationDto,
  QueryApplicationsDto,
  ReviewApplicationDto,
  TrackOnboardingDto,
  UpdateRegistrationGuideDto,
} from './onboarding.dto';
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

    // Direct token match (raw access token or decoded JWT sub)
    if (rawTokenOrCandidateId === app.id) {
      return app;
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
    const normalizedJamb = dto.jambRegNo.trim().toUpperCase();
    const normalizedAppNum = dto.applicationNumber.trim().toUpperCase();

    const application = await this.prisma.onboardingApplication.findFirst({
      where: {
        jambRegNo: normalizedJamb,
        applicationNumber: normalizedAppNum,
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
        'No matching application found. Please check your JAMB Registration Number and Application Number.',
      );
    }

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
    caller: { id?: string; role?: string; applicationId?: string } | null,
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
    // 2) Caller is the candidate owner (matching candidate applicationId or id)
    const isStaff = caller?.role === Role.admin || caller?.role === Role.hod;
    const isOwner =
      caller?.applicationId === doc.applicationId || caller?.id === doc.applicationId;

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
    return this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
      },
    });
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
}
