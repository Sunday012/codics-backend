import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataService } from '../data/data.service';
import { Notice, User } from '../data/entities';
import { NoticeDto } from './notices.dto';

@Injectable()
export class NoticesService {
  constructor(private data: DataService) {}

  matchesAudience(user: User, notice: Notice) {
    if (notice.scope === 'faculty') return true;
    if (notice.targetDepartment && notice.targetDepartment !== user.department) return false;
    if (notice.scope === 'department') return true;
    if (notice.scope === 'level') return !notice.targetLevel || notice.targetLevel === user.level;
    if (notice.scope === 'course') {
      return this.data.db.enrollments.some((e) => e.userId === user.id && e.courseCode === notice.courseCode)
        || this.data.db.offerings.some((o) => o.courseCode === notice.courseCode && o.lecturerIds.includes(user.id));
    }
    return false;
  }

  list(user: User, query: { category?: string; search?: string; page?: string; limit?: string }) {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    let items = this.data.db.notices.filter((n) => !n.isHidden && this.matchesAudience(user, n));
    if (query.category && query.category !== 'all') items = items.filter((n) => n.category === query.category);
    if (query.search) {
      const search = query.search.toLowerCase();
      items = items.filter((n) => `${n.title} ${n.content}`.toLowerCase().includes(search));
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, totalPages: Math.ceil(items.length / limit) };
  }

  get(id: string, user: User) {
    const notice = this.data.db.notices.find((n) => n.id === id && !n.isHidden);
    if (!notice || !this.matchesAudience(user, notice)) throw new NotFoundException('Notice not found');
    return notice;
  }

  async create(user: User, dto: NoticeDto) {
    this.assertCanPublish(user, dto);
    const notice: Notice = { id: randomUUID(), ...dto, isUrgent: dto.isUrgent ?? false, authorId: user.id, authorName: user.name, authorRole: user.role, createdAt: new Date().toISOString(), readBy: [] };
    this.data.db.notices.unshift(notice);
    await this.data.audit(user, 'CREATE_NOTICE', 'Notice', notice.id, notice.title);
    return notice;
  }

  async update(id: string, user: User, dto: NoticeDto) {
    const index = this.data.db.notices.findIndex((n) => n.id === id);
    if (index < 0) throw new NotFoundException('Notice not found');
    const existing = this.data.db.notices[index];
    if (existing.authorId !== user.id && !['admin', 'hod'].includes(user.role)) throw new ForbiddenException('Only the author or an administrator can update this notice');
    this.assertCanPublish(user, dto);
    const updated = { ...existing, ...dto, updatedAt: new Date().toISOString() };
    this.data.db.notices[index] = updated;
    await this.data.audit(user, 'UPDATE_NOTICE', 'Notice', id, updated.title);
    return updated;
  }

  async remove(id: string, user: User) {
    const index = this.data.db.notices.findIndex((n) => n.id === id);
    if (index < 0) throw new NotFoundException('Notice not found');
    const notice = this.data.db.notices[index];
    if (notice.authorId !== user.id && !['admin', 'hod'].includes(user.role)) throw new ForbiddenException('Only the author or an administrator can delete this notice');
    this.data.db.notices.splice(index, 1);
    await this.data.audit(user, 'DELETE_NOTICE', 'Notice', id, notice.title);
    return { success: true };
  }

  async markRead(id: string, user: User) {
    const notice = this.get(id, user);
    if (!notice.readBy.includes(user.id)) notice.readBy.push(user.id);
    await this.data.save();
    return { success: true };
  }

  private assertCanPublish(user: User, dto: NoticeDto) {
    if (user.role === 'student') throw new ForbiddenException('Students cannot publish notices');
    if (user.role === 'course_rep' && (dto.targetDepartment !== user.department || (dto.targetLevel && dto.targetLevel !== user.level))) {
      throw new ForbiddenException('Course representatives can only publish to their own department and level');
    }
    if (['lecturer', 'hod'].includes(user.role) && dto.scope !== 'faculty' && dto.targetDepartment && dto.targetDepartment !== user.department) {
      throw new ForbiddenException('You cannot publish to another department');
    }
    if (dto.scope === 'course' && !dto.courseCode) throw new ForbiddenException('courseCode is required for course notices');
  }
}
