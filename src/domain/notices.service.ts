import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AudienceScope, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthService } from '../auth/auth.service';
import { SafeUser } from '../common/user.util';
import {
  CursorPaginationQuery,
  PaginatedResult,
  parsePaginationParams,
} from '../common/pagination.util';
import { NoticeDto } from './notices.dto';

@Injectable()
export class NoticesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  private mapNotice(
    n: any,
    _userDeptName?: string | null,
  ) {
    return {
      id: n.id,
      title: n.title,
      content: n.body,
      body: n.body,
      category: n.isUrgent ? 'urgent' : 'general',
      scope: n.scope,
      isUrgent: n.isUrgent,
      targetDepartment: n.targetDepartmentCode,
      targetDepartmentCode: n.targetDepartmentCode,
      targetLevel: n.targetLevel ? String(n.targetLevel) : undefined,
      courseCode: n.targetCourseCode,
      targetCourseCode: n.targetCourseCode,
      authorId: n.authorId,
      authorName: n.author?.fullName || '',
      authorRole: n.author?.role || 'admin',
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
      isHidden: n.isHidden,
      hiddenReason: n.hiddenReason,
      hiddenBy: n.hiddenBy,
      hiddenAt: n.hiddenAt ? n.hiddenAt.toISOString() : null,
      readBy: n.reads ? n.reads.map((r: any) => r.userId) : [],
    };
  }

  async list(
    user: SafeUser,
    query: CursorPaginationQuery & {
      category?: string;
      search?: string;
    },
  ): Promise<PaginatedResult<any>> {
    const { cursor, limit, page } = parsePaginationParams(query);
    const role = this.auth.effectiveRole(user);

    // Resolve user's department code and enrolled/lectured course codes
    const [userRecord, enrollments, offerings] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: user.id },
        include: { department: true },
      }),
      this.prisma.enrollment.findMany({
        where: { userId: user.id },
        include: { offering: { include: { course: true } } },
      }),
      this.prisma.offeringLecturer.findMany({
        where: { userId: user.id },
        include: { offering: { include: { course: true } } },
      }),
    ]);

    const userDeptCode = userRecord?.department?.code;
    const userDeptName = userRecord?.department?.name;
    const userCourseCodes = Array.from(
      new Set([
        ...enrollments.map((e) => e.offering.course.code),
        ...offerings.map((o) => o.offering.course.code),
      ]),
    );

    // Build audience filter
    let audienceWhere: any = {};
    if (role !== Role.admin) {
      const deptMatches = [
        ...(userDeptCode ? [{ targetDepartmentCode: userDeptCode }] : []),
        ...(userDeptName ? [{ targetDepartmentCode: userDeptName }] : []),
      ];

      const audienceConditions: any[] = [
        { scope: AudienceScope.faculty },
      ];

      if (deptMatches.length > 0) {
        audienceConditions.push({
          AND: [
            { scope: AudienceScope.department },
            { OR: deptMatches },
          ],
        });

        const levelConditions: any[] = [
          { targetLevel: null },
        ];
        if (user.level) {
          levelConditions.push({ targetLevel: Number(user.level) });
        }

        audienceConditions.push({
          AND: [
            { scope: AudienceScope.level },
            { OR: deptMatches },
            { OR: levelConditions },
          ],
        });
      }

      if (userCourseCodes.length > 0) {
        audienceConditions.push({
          AND: [
            { scope: AudienceScope.course },
            { targetCourseCode: { in: userCourseCodes } },
          ],
        });
      }

      audienceWhere = { OR: audienceConditions };
    }

    // Visibility filter: normal users cannot see hidden notices unless they are the author
    let visibilityWhere: any = {};
    if (role !== Role.admin) {
      visibilityWhere = {
        OR: [
          { isHidden: false },
          { authorId: user.id },
        ],
      };
    }

    // Search filter
    const searchWhere: any = {};
    if (query.search) {
      const s = query.search.trim();
      searchWhere.OR = [
        { title: { contains: s, mode: 'insensitive' } },
        { body: { contains: s, mode: 'insensitive' } },
      ];
    }

    const where: any = {
      AND: [
        audienceWhere,
        visibilityWhere,
        searchWhere,
      ].filter((clause) => Object.keys(clause).length > 0),
    };

    const total = await this.prisma.notice.count({ where });

    let notices: any[];
    let nextCursor: string | null = null;

    if (cursor) {
      notices = await this.prisma.notice.findMany({
        where,
        take: limit + 1,
        skip: 1,
        cursor: { id: cursor },
        orderBy: { createdAt: 'desc' },
        include: {
          author: true,
          reads: true,
        },
      });

      if (notices.length > limit) {
        const nextItem = notices[limit - 1];
        nextCursor = nextItem.id;
        notices = notices.slice(0, limit);
      }
    } else {
      notices = await this.prisma.notice.findMany({
        where,
        take: limit,
        skip: (page - 1) * limit,
        orderBy: { createdAt: 'desc' },
        include: {
          author: true,
          reads: true,
        },
      });

      if (page * limit < total && notices.length > 0) {
        nextCursor = notices[notices.length - 1].id;
      }
    }

    const items = notices.map((n) => this.mapNotice(n, userDeptName));
    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      nextCursor,
    };
  }

  async get(id: string, user: SafeUser) {
    const notice = await this.prisma.notice.findUnique({
      where: { id },
      include: {
        author: { include: { department: true } },
        reads: true,
      },
    });

    if (!notice) throw new NotFoundException('Notice not found');

    const role = this.auth.effectiveRole(user);
    if (notice.isHidden && role !== Role.admin && notice.authorId !== user.id) {
      throw new NotFoundException('Notice not found');
    }

    // Verify audience
    if (role !== Role.admin && notice.authorId !== user.id) {
      const isMatch = await this.matchesAudience(user, notice);
      if (!isMatch) throw new NotFoundException('Notice not found');
    }

    return this.mapNotice(notice);
  }

  async create(user: SafeUser, dto: NoticeDto) {
    this.assertCanPublish(user, dto);

    const scope = dto.scope as AudienceScope;
    const notice = await this.prisma.notice.create({
      data: {
        title: dto.title,
        body: dto.content,
        scope,
        targetDepartmentCode: dto.targetDepartment || null,
        targetLevel: dto.targetLevel ? Number(dto.targetLevel) : null,
        targetCourseCode: dto.courseCode || null,
        isUrgent: dto.isUrgent ?? false,
        authorId: user.id,
      },
      include: {
        author: true,
        reads: true,
      },
    });

    await this.audit.log(user, 'CREATE_NOTICE', 'Notice', notice.id, notice.title);
    return this.mapNotice(notice);
  }

  async update(id: string, user: SafeUser, dto: NoticeDto) {
    const existing = await this.prisma.notice.findUnique({
      where: { id },
      include: { author: { include: { department: true } } },
    });
    if (!existing) throw new NotFoundException('Notice not found');

    const role = this.auth.effectiveRole(user);
    if (existing.authorId !== user.id) {
      if (role === Role.hod) {
        await this.assertHodOwnDepartment(user, existing);
      } else if (role !== Role.admin) {
        throw new ForbiddenException('Only the author or an administrator can update this notice');
      }
    }

    this.assertCanPublish(user, dto);

    const updated = await this.prisma.notice.update({
      where: { id },
      data: {
        title: dto.title,
        body: dto.content,
        scope: dto.scope as AudienceScope,
        targetDepartmentCode: dto.targetDepartment || null,
        targetLevel: dto.targetLevel ? Number(dto.targetLevel) : null,
        targetCourseCode: dto.courseCode || null,
        isUrgent: dto.isUrgent ?? false,
      },
      include: {
        author: true,
        reads: true,
      },
    });

    await this.audit.log(user, 'UPDATE_NOTICE', 'Notice', id, updated.title);
    return this.mapNotice(updated);
  }

  async remove(id: string, user: SafeUser) {
    const existing = await this.prisma.notice.findUnique({
      where: { id },
      include: { author: { include: { department: true } } },
    });
    if (!existing) throw new NotFoundException('Notice not found');

    const role = this.auth.effectiveRole(user);
    if (existing.authorId !== user.id) {
      if (role === Role.hod) {
        await this.assertHodOwnDepartment(user, existing);
      } else if (role !== Role.admin) {
        throw new ForbiddenException('Only the author or an administrator can delete this notice');
      }
    }

    await this.prisma.notice.delete({ where: { id } });
    await this.audit.log(user, 'DELETE_NOTICE', 'Notice', id, existing.title);
    return { success: true };
  }

  async markRead(id: string, user: SafeUser) {
    await this.get(id, user); // verifies existence and audience
    await this.prisma.noticeRead.upsert({
      where: {
        noticeId_userId: {
          noticeId: id,
          userId: user.id,
        },
      },
      update: { readAt: new Date() },
      create: {
        noticeId: id,
        userId: user.id,
      },
    });
    return { success: true };
  }

  async hide(id: string, user: SafeUser, reason?: string) {
    const notice = await this.prisma.notice.findUnique({
      where: { id },
      include: { author: { include: { department: true } } },
    });
    if (!notice) throw new NotFoundException('Notice not found');

    const role = this.auth.effectiveRole(user);
    if (role === Role.hod) {
      await this.assertHodOwnDepartment(user, notice);
    } else if (role !== Role.admin) {
      throw new ForbiddenException('Only administrators and HODs can hide notices');
    }

    const updated = await this.prisma.notice.update({
      where: { id },
      data: {
        isHidden: true,
        hiddenReason: reason || null,
        hiddenBy: user.id,
        hiddenAt: new Date(),
      },
      include: { author: true, reads: true },
    });

    await this.audit.log(user, 'HIDE_NOTICE', 'Notice', id, notice.title, reason);
    return { success: true, message: 'Notice hidden successfully', notice: this.mapNotice(updated) };
  }

  async unhide(id: string, user: SafeUser) {
    const notice = await this.prisma.notice.findUnique({
      where: { id },
      include: { author: { include: { department: true } } },
    });
    if (!notice) throw new NotFoundException('Notice not found');

    const role = this.auth.effectiveRole(user);
    if (role === Role.hod) {
      await this.assertHodOwnDepartment(user, notice);
    } else if (role !== Role.admin) {
      throw new ForbiddenException('Only administrators and HODs can unhide notices');
    }

    const updated = await this.prisma.notice.update({
      where: { id },
      data: {
        isHidden: false,
        hiddenReason: null,
        hiddenBy: null,
        hiddenAt: null,
      },
      include: { author: true, reads: true },
    });

    await this.audit.log(user, 'UNHIDE_NOTICE', 'Notice', id, notice.title);
    return { success: true, message: 'Notice unhidden successfully', notice: this.mapNotice(updated) };
  }

  private async assertHodOwnDepartment(user: SafeUser, notice: any) {
    if (!user.departmentId) {
      throw new ForbiddenException('HOD has no assigned department');
    }
    const userDept = await this.prisma.department.findUnique({
      where: { id: user.departmentId },
    });
    const matchesTarget =
      notice.targetDepartmentCode === userDept?.code ||
      notice.targetDepartmentCode === userDept?.name;
    const matchesAuthor = notice.author?.departmentId === user.departmentId;

    if (!matchesTarget && !matchesAuthor && notice.scope !== AudienceScope.faculty) {
      throw new ForbiddenException('HOD can only moderate notices within their own department');
    }
  }

  private async matchesAudience(user: SafeUser, notice: any): Promise<boolean> {
    if (notice.scope === AudienceScope.faculty) return true;

    const userRecord = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { department: true },
    });
    const userDeptCode = userRecord?.department?.code;
    const userDeptName = userRecord?.department?.name;

    const deptMatches =
      (userDeptCode && notice.targetDepartmentCode === userDeptCode) ||
      (userDeptName && notice.targetDepartmentCode === userDeptName);

    if (notice.scope === AudienceScope.department) {
      return !!deptMatches;
    }
    if (notice.scope === AudienceScope.level) {
      const levelMatches =
        !notice.targetLevel || notice.targetLevel === Number(user.level);
      return !!deptMatches && levelMatches;
    }
    if (notice.scope === AudienceScope.course) {
      if (!notice.targetCourseCode) return false;
      const enrolled = await this.prisma.enrollment.findFirst({
        where: {
          userId: user.id,
          offering: { course: { code: notice.targetCourseCode } },
        },
      });
      if (enrolled) return true;
      const teaching = await this.prisma.offeringLecturer.findFirst({
        where: {
          userId: user.id,
          offering: { course: { code: notice.targetCourseCode } },
        },
      });
      return !!teaching;
    }
    return false;
  }

  private assertCanPublish(user: SafeUser, dto: NoticeDto) {
    const role = this.auth.effectiveRole(user);
    if (role === Role.student) {
      throw new ForbiddenException('Students cannot publish notices');
    }
    if (
      role === Role.course_rep &&
      (dto.targetDepartment !== user.department ||
        (dto.targetLevel && dto.targetLevel !== String(user.level)))
    ) {
      throw new ForbiddenException(
        'Course representatives can only publish to their own department and level',
      );
    }
    if (
      (role === Role.lecturer || role === Role.hod) &&
      dto.scope !== 'faculty' &&
      dto.targetDepartment &&
      dto.targetDepartment !== user.department
    ) {
      throw new ForbiddenException('You cannot publish to another department');
    }
    if (dto.scope === 'course' && !dto.courseCode) {
      throw new ForbiddenException('courseCode is required for course notices');
    }
  }
}
