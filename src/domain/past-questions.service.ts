import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { User } from '../data/entities';
import { PrismaService } from '../database/prisma.service';
import { ReportPaperDto, UploadPaperDto } from './past-questions.dto';

@Injectable()
export class PastQuestionsService {
  constructor(private prisma: PrismaService) {}

  async list(query: Record<string, string>) {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Number(query.limit) || 20, 100);
    const filters = Object.fromEntries(
      ['courseCode', 'department', 'level', 'session', 'semester', 'examType']
        .filter((key) => query[key] && query[key] !== 'all')
        .map((key) => [key, query[key]]),
    );
    const where = {
      status: 'approved', ...filters,
      ...(query.search ? { OR: [
        { courseCode: { contains: query.search, mode: 'insensitive' as const } },
        { courseTitle: { contains: query.search, mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.pastQuestion.findMany({ where, include: { reports: true }, orderBy: { uploadedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.pastQuestion.count({ where }),
    ]);
    return { items, total, page, totalPages: Math.ceil(total / limit) };
  }

  async get(id: string) {
    const paper = await this.prisma.pastQuestion.findFirst({ where: { id, status: 'approved' }, include: { reports: true } });
    if (!paper) throw new NotFoundException('Past question not found');
    return paper;
  }

  async upload(user: User, dto: UploadPaperDto) {
    const duplicate = await this.prisma.pastQuestion.findFirst({ where: {
      courseCode: dto.courseCode, session: dto.session, semester: dto.semester, examType: dto.examType, status: { not: 'rejected' },
    } });
    if (duplicate) throw new ConflictException('A matching paper already exists or is awaiting review');
    const paper = await this.prisma.pastQuestion.create({ data: { ...dto, uploaderId: user.id, uploaderName: user.name, status: 'pending' } });
    await this.prisma.audit(user, 'UPLOAD_PAST_QUESTION', 'PastQuestion', paper.id, `${paper.courseCode} ${paper.session}`);
    return { ...paper, reports: [] };
  }

  pending(user: User) {
    return this.prisma.pastQuestion.findMany({ where: { status: 'pending', ...(user.role === 'admin' ? {} : { department: user.department }) }, include: { reports: true }, orderBy: { uploadedAt: 'asc' } });
  }

  mine(user: User) {
    return this.prisma.pastQuestion.findMany({ where: { uploaderId: user.id }, include: { reports: true }, orderBy: { uploadedAt: 'desc' } });
  }

  async review(id: string, user: User, approved: boolean, reason?: string) {
    const paper = await this.prisma.pastQuestion.findUnique({ where: { id } });
    if (!paper) throw new NotFoundException('Past question not found');
    if (user.role === 'hod' && paper.department !== user.department) throw new ForbiddenException('HOD review is limited to their department');
    const updated = await this.prisma.pastQuestion.update({ where: { id }, data: {
      status: approved ? 'approved' : 'rejected', reviewedBy: user.id, rejectionReason: approved ? null : reason,
    } });
    await this.prisma.audit(user, approved ? 'APPROVE_PAST_QUESTION' : 'REJECT_PAST_QUESTION', 'PastQuestion', id, paper.courseCode, reason);
    return updated;
  }

  async report(id: string, user: User, dto: ReportPaperDto) {
    await this.get(id);
    try {
      await this.prisma.pastQuestionReport.create({ data: { pastQuestionId: id, reportedBy: user.id, reason: dto.reason, note: dto.note } });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('You already reported this paper');
      throw error;
    }
    return { success: true };
  }

  async remove(id: string, user: User) {
    const paper = await this.prisma.pastQuestion.findUnique({ where: { id } });
    if (!paper) throw new NotFoundException('Past question not found');
    if (paper.uploaderId !== user.id && !['admin', 'hod'].includes(user.role)) throw new ForbiddenException('You cannot delete this paper');
    await this.prisma.pastQuestion.delete({ where: { id } });
    await this.prisma.audit(user, 'DELETE_PAST_QUESTION', 'PastQuestion', id, paper.courseCode);
    return { success: true };
  }
}
