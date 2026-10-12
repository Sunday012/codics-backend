import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataService } from '../data/data.service';
import { PastQuestion, User } from '../data/entities';
import { ReportPaperDto, UploadPaperDto } from './past-questions.dto';

@Injectable()
export class PastQuestionsService {
  constructor(private data: DataService) {}
  list(query: Record<string, string>) {
    const page = Math.max(Number(query.page) || 1, 1), limit = Math.min(Number(query.limit) || 20, 100);
    let items = this.data.db.pastQuestions.filter((paper) => paper.status === 'approved');
    for (const key of ['courseCode', 'department', 'level', 'session', 'semester', 'examType'] as const) {
      if (query[key] && query[key] !== 'all') items = items.filter((paper) => paper[key] === query[key]);
    }
    if (query.search) items = items.filter((p) => `${p.courseCode} ${p.courseTitle}`.toLowerCase().includes(query.search.toLowerCase()));
    return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, totalPages: Math.ceil(items.length / limit) };
  }
  get(id: string) {
    const paper = this.data.db.pastQuestions.find((p) => p.id === id && p.status === 'approved');
    if (!paper) throw new NotFoundException('Past question not found');
    return paper;
  }
  async upload(user: User, dto: UploadPaperDto) {
    const duplicate = this.data.db.pastQuestions.some((p) => p.courseCode === dto.courseCode && p.session === dto.session && p.semester === dto.semester && p.examType === dto.examType && p.status !== 'rejected');
    if (duplicate) throw new ConflictException('A matching paper already exists or is awaiting review');
    const paper: PastQuestion = { id: randomUUID(), ...dto, uploaderId: user.id, uploaderName: user.name, status: 'pending', uploadedAt: new Date().toISOString(), reports: [] };
    this.data.db.pastQuestions.unshift(paper);
    await this.data.audit(user, 'UPLOAD_PAST_QUESTION', 'PastQuestion', paper.id, `${paper.courseCode} ${paper.session}`);
    return paper;
  }
  pending(user: User) {
    return this.data.db.pastQuestions.filter((p) => p.status === 'pending' && (user.role === 'admin' || p.department === user.department));
  }
  mine(user: User) { return this.data.db.pastQuestions.filter((p) => p.uploaderId === user.id); }
  async review(id: string, user: User, approved: boolean, reason?: string) {
    const paper = this.data.db.pastQuestions.find((p) => p.id === id);
    if (!paper) throw new NotFoundException('Past question not found');
    if (user.role === 'hod' && paper.department !== user.department) throw new ForbiddenException('HOD review is limited to their department');
    paper.status = approved ? 'approved' : 'rejected';
    paper.reviewedBy = user.id;
    paper.rejectionReason = approved ? undefined : reason;
    await this.data.audit(user, approved ? 'APPROVE_PAST_QUESTION' : 'REJECT_PAST_QUESTION', 'PastQuestion', id, paper.courseCode, reason);
    return paper;
  }
  async report(id: string, user: User, dto: ReportPaperDto) {
    const paper = this.get(id);
    if (paper.reports.some((r) => r.reportedBy === user.id)) throw new ConflictException('You already reported this paper');
    paper.reports.push({ id: randomUUID(), reportedBy: user.id, reason: dto.reason, note: dto.note, createdAt: new Date().toISOString() });
    await this.data.save();
    return { success: true };
  }
  async remove(id: string, user: User) {
    const index = this.data.db.pastQuestions.findIndex((p) => p.id === id);
    if (index < 0) throw new NotFoundException('Past question not found');
    const paper = this.data.db.pastQuestions[index];
    if (paper.uploaderId !== user.id && !['admin', 'hod'].includes(user.role)) throw new ForbiddenException('You cannot delete this paper');
    this.data.db.pastQuestions.splice(index, 1);
    await this.data.audit(user, 'DELETE_PAST_QUESTION', 'PastQuestion', id, paper.courseCode);
    return { success: true };
  }
}
