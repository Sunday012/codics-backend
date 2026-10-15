import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { User } from '../data/entities';
import { PrismaService } from '../database/prisma.service';
import { NoticeDto } from './notices.dto';

@Injectable()
export class NoticesService {
  constructor(private prisma: PrismaService) {}

  private async courseCodesFor(user: User) {
    const [enrollments, offerings] = await Promise.all([
      this.prisma.enrollment.findMany({ where: { userId: user.id }, select: { courseCode: true } }),
      this.prisma.offering.findMany({ where: { lecturerIds: { has: user.id } }, select: { courseCode: true } }),
    ]);
    return [...new Set([...enrollments, ...offerings].map((item) => item.courseCode))];
  }

  private serialize<T extends { reads?: Array<{ userId: string }> }>(notice: T) {
    const { reads = [], ...record } = notice;
    return { ...record, readBy: reads.map((read) => read.userId) };
  }

  async list(user: User, query: { category?: string; search?: string; page?: string; limit?: string }) {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const courseCodes = await this.courseCodesFor(user);
    const where = {
      isHidden: false,
      ...(query.category && query.category !== 'all' ? { category: query.category } : {}),
      ...(query.search ? { OR: [
        { title: { contains: query.search, mode: 'insensitive' as const } },
        { content: { contains: query.search, mode: 'insensitive' as const } },
      ] } : {}),
      AND: [{ OR: [
        { scope: 'faculty' },
        { scope: 'department', targetDepartment: user.department },
        { scope: 'level', targetDepartment: user.department, targetLevel: user.level },
        ...(courseCodes.length ? [{ scope: 'course', courseCode: { in: courseCodes } }] : []),
      ] }],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notice.findMany({ where, include: { reads: { select: { userId: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.notice.count({ where }),
    ]);
    return { items: items.map((item) => this.serialize(item)), total, page, totalPages: Math.ceil(total / limit) };
  }

  async get(id: string, user: User) {
    const notice = await this.prisma.notice.findFirst({ where: { id, isHidden: false }, include: { reads: { select: { userId: true } } } });
    if (!notice) throw new NotFoundException('Notice not found');
    if (notice.scope !== 'faculty') {
      const courseCodes = notice.scope === 'course' ? await this.courseCodesFor(user) : [];
      const matches = notice.scope === 'course'
        ? !!notice.courseCode && courseCodes.includes(notice.courseCode)
        : notice.targetDepartment === user.department && (notice.scope !== 'level' || notice.targetLevel === user.level);
      if (!matches) throw new NotFoundException('Notice not found');
    }
    return this.serialize(notice);
  }

  async create(user: User, dto: NoticeDto) {
    this.assertCanPublish(user, dto);
    const notice = await this.prisma.notice.create({ data: {
      ...dto, isUrgent: dto.isUrgent ?? false, authorId: user.id, authorName: user.name, authorRole: user.role,
    } });
    await this.prisma.audit(user, 'CREATE_NOTICE', 'Notice', notice.id, notice.title);
    return { ...notice, readBy: [] };
  }

  async update(id: string, user: User, dto: NoticeDto) {
    const existing = await this.prisma.notice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Notice not found');
    if (existing.authorId !== user.id && !['admin', 'hod'].includes(user.role)) throw new ForbiddenException('Only the author or an administrator can update this notice');
    this.assertCanPublish(user, dto);
    const updated = await this.prisma.notice.update({ where: { id }, data: dto });
    await this.prisma.audit(user, 'UPDATE_NOTICE', 'Notice', id, updated.title);
    return updated;
  }

  async remove(id: string, user: User) {
    const notice = await this.prisma.notice.findUnique({ where: { id } });
    if (!notice) throw new NotFoundException('Notice not found');
    if (notice.authorId !== user.id && !['admin', 'hod'].includes(user.role)) throw new ForbiddenException('Only the author or an administrator can delete this notice');
    await this.prisma.notice.delete({ where: { id } });
    await this.prisma.audit(user, 'DELETE_NOTICE', 'Notice', id, notice.title);
    return { success: true };
  }

  async markRead(id: string, user: User) {
    await this.get(id, user);
    await this.prisma.noticeRead.upsert({ where: { noticeId_userId: { noticeId: id, userId: user.id } }, update: {}, create: { noticeId: id, userId: user.id } });
    return { success: true };
  }

  private assertCanPublish(user: User, dto: NoticeDto) {
    if (user.role === 'student') throw new ForbiddenException('Students cannot publish notices');
    if (user.role === 'course_rep' && (dto.targetDepartment !== user.department || (dto.targetLevel && dto.targetLevel !== user.level))) throw new ForbiddenException('Course representatives can only publish to their own department and level');
    if (['lecturer', 'hod'].includes(user.role) && dto.scope !== 'faculty' && dto.targetDepartment && dto.targetDepartment !== user.department) throw new ForbiddenException('You cannot publish to another department');
    if (dto.scope === 'course' && !dto.courseCode) throw new ForbiddenException('courseCode is required for course notices');
  }
}
