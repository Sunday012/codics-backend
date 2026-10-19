import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  ExamType,
  PastQuestionStatus,
  Role,
  Semester,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import { AuthService } from '../auth/auth.service';
import { SafeUser } from '../common/user.util';
import {
  CursorPaginationQuery,
  PaginatedResult,
  parsePaginationParams,
} from '../common/pagination.util';
import { ReportPaperDto, UploadPaperDto } from './past-questions.dto';

function toSemesterEnum(sem: string): Semester {
  const s = sem.toLowerCase();
  if (s.includes('second') || s === 'second') return Semester.second;
  return Semester.first;
}

function fromSemesterEnum(sem: Semester): string {
  return sem === Semester.second ? 'Second Semester' : 'First Semester';
}

function toExamTypeEnum(type: string, sem?: Semester): ExamType {
  const t = type.toLowerCase();
  if (t === 'test') return ExamType.test;
  if (t === 'quiz' || t.includes('mid')) return ExamType.mid_semester;
  return sem === Semester.second ? ExamType.second_semester : ExamType.first_semester;
}

function fromExamTypeEnum(type: ExamType): string {
  if (type === ExamType.test) return 'test';
  if (type === ExamType.mid_semester) return 'quiz';
  return 'exam';
}

@Injectable()
export class PastQuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly auth: AuthService,
  ) {}

  private mapPaper(p: any) {
    return {
      id: p.id,
      courseId: p.course?.id || '',
      courseCode: p.courseCode,
      courseTitle: p.course?.title || `${p.courseCode} Course`,
      department: p.course?.department?.name || p.uploader?.department?.name || '',
      level: p.course ? String(p.course.level) : '100',
      session: p.session,
      semester: fromSemesterEnum(p.semester),
      examType: fromExamTypeEnum(p.examType),
      fileName: p.fileName || `${p.courseCode}_${p.session}.pdf`,
      fileUrl: `/api/v1/past-questions/${p.id}/download`,
      status: p.status,
      uploaderId: p.uploaderId,
      uploaderName: p.uploader?.fullName || '',
      uploadedAt: p.createdAt.toISOString(),
      reviewedBy: p.approvedBy,
      rejectionReason: p.rejectionReason,
      reports: (p.reports || []).map((r: any) => ({
        id: r.id,
        reportedBy: r.reportedBy,
        reason: r.reason,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async list(
    query: CursorPaginationQuery & {
      courseCode?: string;
      department?: string;
      level?: string;
      session?: string;
      semester?: string;
      examType?: string;
      search?: string;
    },
  ): Promise<PaginatedResult<any>> {
    const { cursor, limit, page } = parsePaginationParams(query);

    const where: any = {
      deletedAt: null,
      status: PastQuestionStatus.approved,
    };

    if (query.courseCode && query.courseCode !== 'all') {
      where.courseCode = query.courseCode;
    }
    if (query.session && query.session !== 'all') {
      where.session = query.session;
    }
    if (query.semester && query.semester !== 'all') {
      where.semester = toSemesterEnum(query.semester);
    }
    if (query.examType && query.examType !== 'all') {
      where.examType = toExamTypeEnum(query.examType, where.semester);
    }

    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { courseCode: { contains: s, mode: 'insensitive' } },
        { session: { contains: s, mode: 'insensitive' } },
      ];
    }

    const total = await this.prisma.pastQuestion.count({ where });

    let papers: any[];
    let nextCursor: string | null = null;

    if (cursor) {
      papers = await this.prisma.pastQuestion.findMany({
        where,
        take: limit + 1,
        skip: 1,
        cursor: { id: cursor },
        orderBy: { createdAt: 'desc' },
        include: {
          uploader: { include: { department: true } },
          reports: true,
        },
      });

      if (papers.length > limit) {
        nextCursor = papers[limit - 1].id;
        papers = papers.slice(0, limit);
      }
    } else {
      papers = await this.prisma.pastQuestion.findMany({
        where,
        take: limit,
        skip: (page - 1) * limit,
        orderBy: { createdAt: 'desc' },
        include: {
          uploader: { include: { department: true } },
          reports: true,
        },
      });

      if (page * limit < total && papers.length > 0) {
        nextCursor = papers[papers.length - 1].id;
      }
    }

    // Resolve course information for papers
    const courseCodes = Array.from(new Set(papers.map((p) => p.courseCode)));
    const courses = await this.prisma.course.findMany({
      where: { code: { in: courseCodes } },
      include: { department: true },
    });
    const courseMap = new Map(courses.map((c) => [c.code, c]));

    const items = papers.map((p) => {
      p.course = courseMap.get(p.courseCode);
      return this.mapPaper(p);
    });

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      nextCursor,
    };
  }

  async get(id: string) {
    const paper = await this.prisma.pastQuestion.findUnique({
      where: { id },
      include: {
        uploader: { include: { department: true } },
        reports: true,
      },
    });

    if (!paper || paper.deletedAt || paper.status !== PastQuestionStatus.approved) {
      throw new NotFoundException('Past question not found');
    }

    const course = await this.prisma.course.findUnique({
      where: { code: paper.courseCode },
      include: { department: true },
    });
    (paper as any).course = course;

    return this.mapPaper(paper);
  }

  async upload(
    user: SafeUser,
    dto: UploadPaperDto,
    file?: Express.Multer.File,
  ) {
    const role = this.auth.effectiveRole(user);
    if (role === Role.student) {
      throw new ForbiddenException('Students cannot upload past questions');
    }

    const semesterEnum = toSemesterEnum(dto.semester);
    const examTypeEnum = toExamTypeEnum(dto.examType, semesterEnum);

    // Duplicate check: not soft-deleted and not rejected
    const duplicate = await this.prisma.pastQuestion.findFirst({
      where: {
        courseCode: dto.courseCode,
        session: dto.session,
        semester: semesterEnum,
        examType: examTypeEnum,
        deletedAt: null,
        status: { in: [PastQuestionStatus.approved, PastQuestionStatus.pending] },
      },
    });

    if (duplicate) {
      throw new ConflictException(
        'A matching paper already exists or is awaiting review',
      );
    }

    // Role-based approval status
    const isImmediate =
      role === Role.lecturer || role === Role.hod || role === Role.admin;
    const status = isImmediate
      ? PastQuestionStatus.approved
      : PastQuestionStatus.pending;
    const approvedBy = isImmediate ? user.id : null;

    // File handling
    const safeName = (file?.originalname || dto.fileName || `${dto.courseCode}_${dto.session}.pdf`).replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );
    const fileKey = `past-questions/${dto.courseCode}/${randomUUID()}-${safeName}`;
    const fileBuffer = file?.buffer || Buffer.from('%PDF-1.4 Mock Past Question Content');
    const mimeType = file?.mimetype || 'application/pdf';
    const checksum = createHash('sha256').update(fileBuffer).digest('hex');

    await this.storage.putObject(fileKey, fileBuffer, mimeType);

    const paper = await this.prisma.pastQuestion.create({
      data: {
        uploaderId: user.id,
        courseCode: dto.courseCode,
        session: dto.session,
        semester: semesterEnum,
        examType: examTypeEnum,
        fileKey,
        fileName: safeName,
        sizeBytes: fileBuffer.length,
        mimeType,
        sha256: checksum,
        status,
        approvedBy,
      },
      include: {
        uploader: { include: { department: true } },
        reports: true,
      },
    });

    await this.audit.log(
      user,
      'UPLOAD_PAST_QUESTION',
      'PastQuestion',
      paper.id,
      `${paper.courseCode} ${paper.session}`,
    );

    const course = await this.prisma.course.findUnique({
      where: { code: paper.courseCode },
      include: { department: true },
    });
    (paper as any).course = course;

    return this.mapPaper(paper);
  }

  async pending(user: SafeUser) {
    const role = this.auth.effectiveRole(user);

    const papers = await this.prisma.pastQuestion.findMany({
      where: {
        status: PastQuestionStatus.pending,
        deletedAt: null,
      },
      include: {
        uploader: { include: { department: true } },
        reports: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const courseCodes = Array.from(new Set(papers.map((p) => p.courseCode)));
    const courses = await this.prisma.course.findMany({
      where: { code: { in: courseCodes } },
      include: { department: true },
    });
    const courseMap = new Map(courses.map((c) => [c.code, c]));

    const mapped = papers.map((p) => {
      (p as any).course = courseMap.get(p.courseCode);
      return this.mapPaper(p);
    });

    if (role === Role.admin) {
      return mapped;
    }

    // HOD filter to own department
    return mapped.filter((p) => p.department === user.department);
  }

  async mine(user: SafeUser) {
    const papers = await this.prisma.pastQuestion.findMany({
      where: {
        uploaderId: user.id,
        deletedAt: null,
      },
      include: {
        uploader: { include: { department: true } },
        reports: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const courseCodes = Array.from(new Set(papers.map((p) => p.courseCode)));
    const courses = await this.prisma.course.findMany({
      where: { code: { in: courseCodes } },
      include: { department: true },
    });
    const courseMap = new Map(courses.map((c) => [c.code, c]));

    return papers.map((p) => {
      (p as any).course = courseMap.get(p.courseCode);
      return this.mapPaper(p);
    });
  }

  async review(id: string, user: SafeUser, approved: boolean, reason?: string) {
    const paper = await this.prisma.pastQuestion.findUnique({
      where: { id },
      include: {
        uploader: { include: { department: true } },
      },
    });

    if (!paper || paper.deletedAt) {
      throw new NotFoundException('Past question not found');
    }

    const course = await this.prisma.course.findUnique({
      where: { code: paper.courseCode },
      include: { department: true },
    });
    const paperDeptName = course?.department?.name || paper.uploader?.department?.name;

    const role = this.auth.effectiveRole(user);
    if (role === Role.hod && paperDeptName !== user.department) {
      throw new ForbiddenException('HOD review is limited to their department');
    }

    const updated = await this.prisma.pastQuestion.update({
      where: { id },
      data: {
        status: approved ? PastQuestionStatus.approved : PastQuestionStatus.rejected,
        approvedBy: approved ? user.id : null,
        rejectionReason: approved ? null : reason || null,
      },
      include: {
        uploader: { include: { department: true } },
        reports: true,
      },
    });

    (updated as any).course = course;

    await this.audit.log(
      user,
      approved ? 'APPROVE_PAST_QUESTION' : 'REJECT_PAST_QUESTION',
      'PastQuestion',
      id,
      paper.courseCode,
      reason,
    );

    return this.mapPaper(updated);
  }

  async report(id: string, user: SafeUser, dto: ReportPaperDto) {
    const paper = await this.prisma.pastQuestion.findUnique({
      where: { id },
      include: { reports: true },
    });

    if (!paper || paper.deletedAt || paper.status !== PastQuestionStatus.approved) {
      throw new NotFoundException('Past question not found');
    }

    if (paper.reports.some((r) => r.reportedBy === user.id)) {
      throw new ConflictException('You already reported this paper');
    }

    await this.prisma.pastQuestionReport.create({
      data: {
        pastQuestionId: id,
        reportedBy: user.id,
        reason: dto.reason,
        note: dto.note || null,
      },
    });

    return { success: true };
  }

  async remove(id: string, user: SafeUser) {
    const paper = await this.prisma.pastQuestion.findUnique({
      where: { id },
      include: {
        uploader: { include: { department: true } },
      },
    });

    if (!paper || paper.deletedAt) {
      throw new NotFoundException('Past question not found');
    }

    const role = this.auth.effectiveRole(user);
    if (role === Role.hod) {
      const course = await this.prisma.course.findUnique({
        where: { code: paper.courseCode },
        include: { department: true },
      });
      const paperDept = course?.department?.name || paper.uploader?.department?.name;
      if (paperDept !== user.department) {
        throw new ForbiddenException(
          'HOD can only delete past questions in their department',
        );
      }
    } else if (paper.uploaderId !== user.id && role !== Role.admin) {
      throw new ForbiddenException('You cannot delete this paper');
    }

    // Soft delete
    await this.prisma.pastQuestion.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.log(
      user,
      'DELETE_PAST_QUESTION',
      'PastQuestion',
      id,
      paper.courseCode,
    );

    return { success: true };
  }

  async getDownloadFile(id: string, user: SafeUser) {
    const paper = await this.prisma.pastQuestion.findUnique({
      where: { id },
      include: {
        uploader: { include: { department: true } },
      },
    });

    if (!paper || paper.deletedAt) {
      throw new NotFoundException('Past question not found');
    }

    const role = this.auth.effectiveRole(user);
    if (paper.status !== PastQuestionStatus.approved) {
      const course = await this.prisma.course.findUnique({
        where: { code: paper.courseCode },
        include: { department: true },
      });
      const paperDept = course?.department?.name || paper.uploader?.department?.name;

      const canViewPending =
        role === Role.admin ||
        paper.uploaderId === user.id ||
        (role === Role.hod && paperDept === user.department);

      if (!canViewPending) {
        throw new ForbiddenException('You do not have permission to download this paper');
      }
    }

    if (!paper.fileKey) {
      throw new NotFoundException('File not found for this past question');
    }

    const buffer = await this.storage.getObject(paper.fileKey);
    return {
      buffer,
      fileName: paper.fileName || `${paper.courseCode}_${paper.session}.pdf`,
      mimeType: paper.mimeType || 'application/pdf',
      sizeBytes: paper.sizeBytes || buffer.length,
    };
  }
}
