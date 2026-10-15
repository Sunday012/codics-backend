import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { User } from '../data/entities';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { AssignmentDto, ExtendDeadlineDto, GradeDto } from './assignments.dto';

type AssignmentRecord = { id: string; offeringId: string; lecturerIds: string[]; dueDate: Date; allowLate: boolean; allowedFileTypes: string[]; maxSizeBytes: number; courseCode: string; title: string; totalMarks: number; studentDeadlineExtensions: unknown };

@Injectable()
export class AssignmentsService {
  constructor(private prisma: PrismaService) {}

  private serializeSubmission<T extends { fileData?: Uint8Array }>(submission: T) {
    const { fileData: _fileData, ...safe } = submission;
    return safe;
  }

  async list(user: User, query: { courseCode?: string; tab?: string }) {
    let items = await this.prisma.assignment.findMany({
      where: {
        ...(query.courseCode && query.courseCode !== 'all' ? { courseCode: query.courseCode } : {}),
        ...(['student', 'course_rep'].includes(user.role)
          ? { status: 'published', offering: { enrollments: { some: { userId: user.id } } } }
          : user.role === 'lecturer'
            ? { OR: [{ status: 'published' }, { lecturerIds: { has: user.id } }] }
            : {}),
      },
      include: { submissions: { where: { studentId: user.id }, select: { status: true } } },
      orderBy: { dueDate: 'asc' },
    });
    if (query.tab && query.tab !== 'all') {
      items = items.filter((assignment) => {
        const submission = assignment.submissions[0];
        const extensions = assignment.studentDeadlineExtensions as Record<string, string>;
        const due = new Date(extensions[user.id] ?? assignment.dueDate).getTime();
        if (query.tab === 'upcoming') return !submission && due >= Date.now();
        if (query.tab === 'submitted') return !!submission && submission.status !== 'graded';
        if (query.tab === 'graded') return submission?.status === 'graded';
        if (query.tab === 'overdue') return !submission && due < Date.now();
        return true;
      });
    }
    return items.map(({ submissions: _submissions, ...assignment }) => assignment);
  }

  async get(id: string, user: User) {
    const assignment = await this.find(id);
    const ownSubmission = await this.prisma.submission.findUnique({ where: { assignmentId_studentId: { assignmentId: id, studentId: user.id } } });
    return { ...assignment, ownSubmission: ownSubmission ? this.serializeSubmission(ownSubmission) : null };
  }

  async create(user: User, dto: AssignmentDto) {
    const offering = await this.prisma.offering.findUnique({ where: { id: dto.offeringId } });
    if (!offering) throw new BadRequestException('Course offering not found');
    if (user.role === 'lecturer' && !offering.lecturerIds.includes(user.id)) throw new ForbiddenException('You are not assigned to this course offering');
    const assignment = await this.prisma.assignment.create({ data: {
      ...dto, dueDate: new Date(dto.dueDate), status: dto.status ?? 'published', lecturerIds: offering.lecturerIds,
    } });
    await this.prisma.audit(user, 'CREATE_ASSIGNMENT', 'Assignment', assignment.id, assignment.title);
    return assignment;
  }

  async submit(id: string, user: User, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('A submission file is required');
    const assignment = await this.find(id);
    const isEnrolled = await this.prisma.enrollment.findUnique({ where: { userId_offeringId: { userId: user.id, offeringId: assignment.offeringId } } });
    if (!isEnrolled) throw new ForbiddenException('You are not enrolled in this course offering');
    const extension = `.${file.originalname.split('.').pop()?.toLowerCase()}`;
    if (!assignment.allowedFileTypes.map((type) => type.toLowerCase()).includes(extension)) throw new BadRequestException(`Allowed file types: ${assignment.allowedFileTypes.join(', ')}`);
    if (file.size > assignment.maxSizeBytes) throw new BadRequestException('File exceeds the assignment size limit');

    const extensions = assignment.studentDeadlineExtensions as Record<string, string>;
    const due = new Date(extensions[user.id] ?? assignment.dueDate).getTime();
    const isLate = Date.now() > due;
    if (isLate && !assignment.allowLate) throw new ForbiddenException('Submission is locked because the deadline has passed');

    const existing = await this.prisma.submission.findUnique({ where: { assignmentId_studentId: { assignmentId: id, studentId: user.id } } });
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const timestamp = new Date();
    const submissionId = existing?.id ?? randomUUID();
    const fileUrl = `/api/v1/submissions/${submissionId}/file`;
    const previousVersions = Array.isArray(existing?.versions) ? existing.versions : [];
    const version = { version: previousVersions.length + 1, fileUrl, fileName: file.originalname, fileSizeBytes: file.size, sha256: checksum, submittedAt: timestamp.toISOString(), isLate };
    const versions = [...previousVersions, version] as Prisma.InputJsonValue;
    const currentVersion = version as Prisma.InputJsonValue;
    const fileData = new Uint8Array(file.buffer);
    const submission = await this.prisma.submission.upsert({
      where: { assignmentId_studentId: { assignmentId: id, studentId: user.id } },
      update: { version: version.version, fileName: file.originalname, fileUrl, fileSize: file.size, fileData, submittedAt: timestamp, isLate, versions, currentVersion, status: isLate ? 'late' : 'submitted', score: null, feedback: null },
      create: { id: submissionId, assignmentId: id, courseCode: assignment.courseCode, studentId: user.id, studentName: user.name, studentMatric: user.matricNo ?? user.id, version: 1, fileName: file.originalname, fileUrl, fileSize: file.size, fileData, submittedAt: timestamp, isLate, versions, currentVersion, status: isLate ? 'late' : 'submitted' },
    });
    const safe = this.serializeSubmission(submission);
    return { ...safe, receipt: { receiptId: randomUUID(), submissionId: submission.id, fileName: version.fileName, fileSizeBytes: version.fileSizeBytes, sha256: checksum, serverTimestamp: timestamp.toISOString() } };
  }

  async submissions(assignmentId: string, user: User) {
    const assignment = await this.find(assignmentId);
    if (user.role === 'course_rep') throw new ForbiddenException('Course representatives cannot access submission files');
    if (user.role === 'student') {
      const own = await this.prisma.submission.findMany({ where: { assignmentId, studentId: user.id } });
      return own.map((item) => this.serializeSubmission(item));
    }
    if (!this.canManage(user, assignment)) throw new ForbiddenException('You are not assigned to this course offering');
    const submissions = await this.prisma.submission.findMany({ where: { assignmentId }, orderBy: { submittedAt: 'desc' } });
    return submissions.map((item) => this.serializeSubmission(item));
  }

  async grade(id: string, user: User, dto: GradeDto) {
    const submission = await this.prisma.submission.findUnique({ where: { id }, include: { assignment: true } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (!this.canManage(user, submission.assignment)) throw new ForbiddenException('You cannot grade this submission');
    if (dto.score > submission.assignment.totalMarks) throw new BadRequestException(`Score cannot exceed ${submission.assignment.totalMarks}`);
    const updated = await this.prisma.submission.update({ where: { id }, data: { score: dto.score, feedback: dto.feedback, status: 'graded' } });
    await this.prisma.audit(user, 'GRADE_SUBMISSION', 'Submission', id, submission.studentMatric);
    return this.serializeSubmission(updated);
  }

  async extend(id: string, user: User, dto: ExtendDeadlineDto) {
    const assignment = await this.find(id);
    if (!this.canManage(user, assignment)) throw new ForbiddenException('You cannot extend this deadline');
    const updated = dto.studentId
      ? await this.prisma.assignment.update({ where: { id }, data: { studentDeadlineExtensions: { ...(assignment.studentDeadlineExtensions as Record<string, string>), [dto.studentId]: dto.dueDate } } })
      : await this.prisma.assignment.update({ where: { id }, data: { dueDate: new Date(dto.dueDate) } });
    await this.prisma.audit(user, 'EXTEND_DEADLINE', 'Assignment', id, assignment.title, dto.reason);
    return updated;
  }

  async headcount(id: string, _user: User) {
    const assignment = await this.find(id);
    const [enrollments, submissions] = await Promise.all([
      this.prisma.enrollment.findMany({ where: { offeringId: assignment.offeringId }, include: { user: true } }),
      this.prisma.submission.findMany({ where: { assignmentId: id }, select: { studentId: true, studentName: true, studentMatric: true, submittedAt: true } }),
    ]);
    return {
      total: enrollments.length, submittedCount: submissions.length,
      submitted: submissions.map((item) => ({ name: item.studentName, matric: item.studentMatric, submittedAt: item.submittedAt })),
      notSubmitted: enrollments.filter(({ user }) => !submissions.some((item) => item.studentId === user.id)).map(({ user }) => ({ name: user.name, matric: user.matricNo })),
    };
  }

  file(id: string, user: User) {
    return this.prisma.submission.findUnique({ where: { id }, include: { assignment: true } }).then((submission) => {
      if (!submission) throw new NotFoundException('Submission not found');
      if (submission.studentId !== user.id && !this.canManage(user, submission.assignment)) throw new ForbiddenException('You cannot access this submission file');
      return { data: submission.fileData, name: submission.fileName };
    });
  }

  private async find(id: string) {
    const assignment = await this.prisma.assignment.findUnique({ where: { id } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    return assignment;
  }

  private canManage(user: User, assignment: AssignmentRecord) {
    return ['admin', 'hod'].includes(user.role) || (user.role === 'lecturer' && assignment.lecturerIds.includes(user.id));
  }
}
