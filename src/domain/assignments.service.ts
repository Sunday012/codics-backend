import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataService } from '../data/data.service';
import { Assignment, Submission, User } from '../data/entities';
import { AssignmentDto, ExtendDeadlineDto, GradeDto } from './assignments.dto';

@Injectable()
export class AssignmentsService {
  constructor(private data: DataService) {}

  list(user: User, query: { courseCode?: string; tab?: string }) {
    let items = this.data.db.assignments.filter((a) => a.status === 'published' || this.canManage(user, a));
    if (query.courseCode && query.courseCode !== 'all') items = items.filter((a) => a.courseCode === query.courseCode);
    if (user.role === 'student' || user.role === 'course_rep') {
      const enrolled = new Set(this.data.db.enrollments.filter((e) => e.userId === user.id).map((e) => e.offeringId));
      items = items.filter((a) => enrolled.has(a.offeringId));
    }
    if (query.tab && query.tab !== 'all') {
      items = items.filter((assignment) => {
        const submission = this.data.db.submissions.find((s) => s.assignmentId === assignment.id && s.studentId === user.id);
        const due = new Date(assignment.studentDeadlineExtensions[user.id] ?? assignment.dueDate).getTime();
        if (query.tab === 'upcoming') return !submission && due >= Date.now();
        if (query.tab === 'submitted') return !!submission && submission.status !== 'graded';
        if (query.tab === 'graded') return submission?.status === 'graded';
        if (query.tab === 'overdue') return !submission && due < Date.now();
        return true;
      });
    }
    return items;
  }

  get(id: string, user: User) {
    const assignment = this.find(id);
    const ownSubmission = this.data.db.submissions.find((s) => s.assignmentId === id && s.studentId === user.id);
    return { ...assignment, ownSubmission };
  }

  async create(user: User, dto: AssignmentDto) {
    const offering = this.data.db.offerings.find((o) => o.id === dto.offeringId);
    if (!offering) throw new BadRequestException('Course offering not found');
    if (user.role === 'lecturer' && !offering.lecturerIds.includes(user.id)) throw new ForbiddenException('You are not assigned to this course offering');
    const assignment: Assignment = {
      id: randomUUID(), ...dto, status: dto.status ?? 'published', createdAt: new Date().toISOString(),
      lecturerIds: offering.lecturerIds, studentDeadlineExtensions: {},
    };
    this.data.db.assignments.unshift(assignment);
    await this.data.audit(user, 'CREATE_ASSIGNMENT', 'Assignment', assignment.id, assignment.title);
    return assignment;
  }

  async submit(id: string, user: User, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('A submission file is required');
    const assignment = this.find(id);
    const isEnrolled = this.data.db.enrollments.some((e) => e.userId === user.id && e.offeringId === assignment.offeringId);
    if (!isEnrolled) throw new ForbiddenException('You are not enrolled in this course offering');
    const extension = `.${file.originalname.split('.').pop()?.toLowerCase()}`;
    if (!assignment.allowedFileTypes.map((t) => t.toLowerCase()).includes(extension)) {
      throw new BadRequestException(`Allowed file types: ${assignment.allowedFileTypes.join(', ')}`);
    }
    if (file.size > assignment.maxSizeBytes) throw new BadRequestException('File exceeds the assignment size limit');
    const due = new Date(assignment.studentDeadlineExtensions[user.id] ?? assignment.dueDate).getTime();
    const isLate = Date.now() > due;
    if (isLate && !assignment.allowLate) throw new ForbiddenException('Submission is locked because the deadline has passed');
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const timestamp = new Date().toISOString();
    const fileUrl = `/api/v1/submissions/files/${randomUUID()}/${encodeURIComponent(file.originalname)}`;
    let submission = this.data.db.submissions.find((s) => s.assignmentId === id && s.studentId === user.id);
    const version = {
      version: (submission?.versions.length ?? 0) + 1, fileUrl, fileName: file.originalname,
      fileSizeBytes: file.size, sha256: checksum, submittedAt: timestamp, isLate,
    };
    if (submission) {
      submission.versions.push(version);
      Object.assign(submission, { version: version.version, fileName: version.fileName, fileUrl, fileSize: file.size, submittedAt: timestamp, isLate, currentVersion: version, status: isLate ? 'late' : 'submitted', score: undefined, feedback: undefined });
    } else {
      submission = {
        id: randomUUID(), assignmentId: id, courseCode: assignment.courseCode, studentId: user.id,
        studentName: user.name, studentMatric: user.matricNo ?? user.id, version: 1,
        fileName: file.originalname, fileUrl, fileSize: file.size, submittedAt: timestamp, isLate,
        versions: [version], currentVersion: version, status: isLate ? 'late' : 'submitted',
      };
      this.data.db.submissions.push(submission);
    }
    // Files are persisted as base64 alongside metadata to keep this starter deployable without object storage.
    (submission.currentVersion as typeof version & { data?: string }).data = file.buffer.toString('base64');
    await this.data.save();
    return { ...submission, receipt: { receiptId: randomUUID(), submissionId: submission.id, fileName: version.fileName, fileSizeBytes: version.fileSizeBytes, sha256: checksum, serverTimestamp: timestamp } };
  }

  submissions(assignmentId: string, user: User) {
    const assignment = this.find(assignmentId);
    if (user.role === 'course_rep') throw new ForbiddenException('Course representatives cannot access submission files');
    if (user.role === 'student') return this.data.db.submissions.filter((s) => s.assignmentId === assignmentId && s.studentId === user.id);
    if (!this.canManage(user, assignment)) throw new ForbiddenException('You are not assigned to this course offering');
    return this.data.db.submissions.filter((s) => s.assignmentId === assignmentId);
  }

  async grade(id: string, user: User, dto: GradeDto) {
    const submission = this.data.db.submissions.find((s) => s.id === id);
    if (!submission) throw new NotFoundException('Submission not found');
    const assignment = this.find(submission.assignmentId);
    if (!this.canManage(user, assignment)) throw new ForbiddenException('You cannot grade this submission');
    if (dto.score > assignment.totalMarks) throw new BadRequestException(`Score cannot exceed ${assignment.totalMarks}`);
    Object.assign(submission, { score: dto.score, feedback: dto.feedback, status: 'graded' });
    await this.data.audit(user, 'GRADE_SUBMISSION', 'Submission', id, submission.studentMatric);
    return submission;
  }

  async extend(id: string, user: User, dto: ExtendDeadlineDto) {
    const assignment = this.find(id);
    if (!this.canManage(user, assignment)) throw new ForbiddenException('You cannot extend this deadline');
    if (dto.studentId) assignment.studentDeadlineExtensions[dto.studentId] = dto.dueDate;
    else assignment.dueDate = dto.dueDate;
    await this.data.audit(user, 'EXTEND_DEADLINE', 'Assignment', id, assignment.title, dto.reason);
    return assignment;
  }

  headcount(id: string, user: User) {
    const assignment = this.find(id);
    const enrollmentIds = this.data.db.enrollments.filter((e) => e.offeringId === assignment.offeringId).map((e) => e.userId);
    const students = this.data.db.users.filter((u) => enrollmentIds.includes(u.id));
    const submissions = this.data.db.submissions.filter((s) => s.assignmentId === id);
    return {
      total: students.length,
      submittedCount: submissions.length,
      submitted: submissions.map((s) => ({ name: s.studentName, matric: s.studentMatric, submittedAt: s.submittedAt })),
      notSubmitted: students.filter((student) => !submissions.some((s) => s.studentId === student.id)).map((s) => ({ name: s.name, matric: s.matricNo })),
    };
  }

  private find(id: string) {
    const assignment = this.data.db.assignments.find((a) => a.id === id);
    if (!assignment) throw new NotFoundException('Assignment not found');
    return assignment;
  }
  private canManage(user: User, assignment: Assignment) {
    return ['admin', 'hod'].includes(user.role) || (user.role === 'lecturer' && assignment.lecturerIds.includes(user.id));
  }
}
