import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  AudienceScope,
  MaterialStatus,
  PastQuestionStatus,
  Role,
  UserStatus,
} from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { SafeUser } from '../common/user.util';
import { PrismaService } from '../prisma/prisma.service';
import { GlobalSearchQueryDto, SearchEntityTypeFilter } from './search.dto';

export type SearchResultType =
  | 'course'
  | 'lesson'
  | 'notice'
  | 'past_question'
  | 'assignment'
  | 'calendar'
  | 'staff';

export interface SearchResultItem {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle: string;
  snippet?: string;
  badge?: string;
  href: string;
  keywords: string[];
  score: number;
}

export interface GlobalSearchResponse {
  query: string;
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
  items: SearchResultItem[];
  grouped: Record<SearchResultType, SearchResultItem[]>;
  indexedTypes: SearchResultType[];
  engine: 'postgres_fts_hybrid';
}

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[_/-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private compactCode(value: string): string {
    return this.normalizeText(value).replace(/\s+/g, '');
  }

  private scoreItem(
    rawQuery: string,
    fields: {
      title: string;
      subtitle: string;
      snippet?: string;
      badge?: string;
      keywords: string[];
    },
    ftsBoost = 0,
  ): number {
    const query = this.normalizeText(rawQuery);
    if (!query) return 0;

    const queryCompact = this.compactCode(rawQuery);
    const tokens = query.split(' ').filter(Boolean);

    const title = this.normalizeText(fields.title);
    const subtitle = this.normalizeText(fields.subtitle);
    const snippet = this.normalizeText(fields.snippet || '');
    const badge = this.normalizeText(fields.badge || '');
    const keywordBlob = this.normalizeText(fields.keywords.join(' '));
    const fullBlob = `${title} ${subtitle} ${snippet} ${badge} ${keywordBlob}`;
    const fullCompact = fullBlob.replace(/\s+/g, '');

    const allTokensMatch = tokens.every(
      (token) =>
        fullBlob.includes(token) ||
        fullCompact.includes(token.replace(/\s+/g, '')),
    );
    if (!allTokensMatch && ftsBoost <= 0) {
      return 0;
    }

    let score = ftsBoost * 50;

    if (badge && (badge === query || badge.replace(/\s+/g, '') === queryCompact)) {
      score += 140;
    }
    if (title === query || title.replace(/\s+/g, '') === queryCompact) {
      score += 130;
    } else if (
      title.startsWith(query) ||
      title.replace(/\s+/g, '').startsWith(queryCompact)
    ) {
      score += 95;
    } else if (title.includes(query)) {
      score += 70;
    }

    if (subtitle.includes(query)) {
      score += 45;
    }
    if (snippet.includes(query)) {
      score += 30;
    }

    for (const token of tokens) {
      if (title.includes(token)) score += 22;
      if (badge.includes(token)) score += 20;
      if (subtitle.includes(token)) score += 12;
      if (keywordBlob.includes(token)) score += 10;
      if (snippet.includes(token)) score += 6;
    }

    return Math.round(score);
  }

  private async getFtsRankedIds(
    table: 'Notice' | 'Course' | 'Material' | 'Assignment' | 'PastQuestion',
    vectorExpr: string,
    query: string,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (typeof (this.prisma as any).$queryRawUnsafe !== 'function') {
      return map;
    }
    try {
      const sql = `
        SELECT "id",
               ts_rank(to_tsvector('english', ${vectorExpr}), websearch_to_tsquery('english', $1)) AS rank
        FROM "${table}"
        WHERE to_tsvector('english', ${vectorExpr}) @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 100
      `;
      const rows: { id: string; rank: number }[] = await (
        this.prisma as any
      ).$queryRawUnsafe(sql, query);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.id) {
            map.set(row.id, Number(row.rank) || 0.5);
          }
        }
      }
    } catch {
      // Fallback gracefully when SQLite/mock or non-standard tsquery characters are used
    }
    return map;
  }

  async search(
    user: SafeUser,
    dto: GlobalSearchQueryDto,
  ): Promise<GlobalSearchResponse> {
    const rawQuery = (dto.q ?? '').trim();
    if (rawQuery.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException(
        `Search query must be at least ${MIN_QUERY_LENGTH} characters long.`,
      );
    }
    if (rawQuery.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(
        `Search query must not exceed ${MAX_QUERY_LENGTH} characters.`,
      );
    }

    const typeFilter: SearchEntityTypeFilter = dto.type || 'all';
    const page = Math.max(1, Number.parseInt(dto.page || '1', 10) || 1);
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(dto.limit || '20', 10) || 20),
    );

    const role = this.auth.effectiveRole(user);

    // Resolve user context (department, level, enrolled/lectured offerings)
    const [userRecord, enrollments, lecturedOfferings] = await Promise.all([
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

    const userDeptId = userRecord?.departmentId ?? user.departmentId ?? null;
    const userDeptCode = userRecord?.department?.code ?? null;
    const userDeptName = userRecord?.department?.name ?? null;
    const rawLevel = userRecord?.level ?? user.level ?? null;
    const userLevel =
      rawLevel !== null && rawLevel !== undefined ? Number(rawLevel) || null : null;

    const enrolledOfferingIds = new Set(enrollments.map((e) => e.offeringId));
    const lecturedOfferingIds = new Set(
      lecturedOfferings.map((o) => o.offeringId),
    );
    const userCourseCodes = new Set<string>([
      ...enrollments.map((e) => e.offering.course.code),
      ...lecturedOfferings.map((o) => o.offering.course.code),
    ]);

    const shouldSearch = (t: SearchResultType) =>
      typeFilter === 'all' || typeFilter === t;

    const tokens = rawQuery
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const searchTokens = tokens.length > 0 ? tokens : [rawQuery];

    const results: SearchResultItem[] = [];

    // 1. Courses
    if (shouldSearch('course')) {
      const ftsRanks = await this.getFtsRankedIds(
        'Course',
        `coalesce("code", '') || ' ' || coalesce("title", '')`,
        rawQuery,
      );
      const ftsIds = Array.from(ftsRanks.keys());

      const courses = await this.prisma.course.findMany({
        where: {
          OR: [
            ...(ftsIds.length > 0 ? [{ id: { in: ftsIds } }] : []),
            ...searchTokens.flatMap((tok) => [
              { code: { contains: tok, mode: 'insensitive' as const } },
              { title: { contains: tok, mode: 'insensitive' as const } },
              {
                department: {
                  name: { contains: tok, mode: 'insensitive' as const },
                },
              },
              {
                department: {
                  code: { contains: tok, mode: 'insensitive' as const },
                },
              },
            ]),
          ],
        },
        include: {
          department: true,
          offerings: {
            include: {
              lecturers: { include: { user: true } },
            },
          },
        },
        take: 80,
      });

      for (const course of courses) {
        const lecturerNames = Array.from(
          new Set(
            course.offerings.flatMap((o) =>
              o.lecturers.map((l) => l.user.fullName),
            ),
          ),
        );
        const itemBase = {
          id: `course-${course.id}`,
          type: 'course' as const,
          title: `${course.code} — ${course.title}`,
          subtitle: `${course.department?.name || 'Computing'} • ${course.level}L • ${course.units} Units`,
          snippet:
            lecturerNames.length > 0
              ? `Lecturer(s): ${lecturerNames.join(', ')}`
              : `${course.semester === 'first' ? 'First Semester' : 'Second Semester'} course`,
          badge: course.code,
          href: `/courses/${course.id}`,
          keywords: [
            course.code,
            course.title,
            course.department?.name || '',
            course.department?.code || '',
            `${course.level}L`,
            ...lecturerNames,
          ],
        };
        const score = this.scoreItem(
          rawQuery,
          itemBase,
          ftsRanks.get(course.id) || 0,
        );
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // 2. Materials & Lessons (strictly respecting draft visibility & soft deletes)
    if (shouldSearch('lesson')) {
      const ftsRanks = await this.getFtsRankedIds(
        'Material',
        `coalesce("title", '') || ' ' || coalesce("fileName", '') || ' ' || coalesce("body", '')`,
        rawQuery,
      );
      const ftsIds = Array.from(ftsRanks.keys());

      const materials = await this.prisma.material.findMany({
        where: {
          deletedAt: null,
          module: { deletedAt: null },
          OR: [
            ...(ftsIds.length > 0 ? [{ id: { in: ftsIds } }] : []),
            ...searchTokens.flatMap((tok) => [
              { title: { contains: tok, mode: 'insensitive' as const } },
              { fileName: { contains: tok, mode: 'insensitive' as const } },
              { body: { contains: tok, mode: 'insensitive' as const } },
              {
                module: {
                  title: { contains: tok, mode: 'insensitive' as const },
                },
              },
              {
                offering: {
                  course: {
                    code: { contains: tok, mode: 'insensitive' as const },
                  },
                },
              },
            ]),
          ],
        },
        include: {
          module: true,
          offering: {
            include: {
              course: { include: { department: true } },
            },
          },
        },
        take: 100,
      });

      for (const mat of materials) {
        // Enforce material visibility: students/course_reps never see draft materials;
        // lecturers only see drafts on their own offerings; HODs only in their department.
        if (mat.status === MaterialStatus.draft) {
          const canViewDraft =
            role === Role.admin ||
            (role === Role.lecturer &&
              lecturedOfferingIds.has(mat.offeringId)) ||
            (role === Role.hod &&
              Boolean(userDeptId) &&
              mat.offering.course.departmentId === userDeptId);
          if (!canViewDraft) {
            continue;
          }
        }

        const course = mat.offering.course;
        const itemBase = {
          id: `lesson-${mat.id}`,
          type: 'lesson' as const,
          title: mat.title,
          subtitle: `${course.code} • ${mat.module?.title || 'Course Module'}`,
          snippet: `${mat.type.toUpperCase()} material in ${course.title}`,
          badge: `${course.code} • ${mat.type.toUpperCase()}`,
          href: `/courses/${course.id}`,
          keywords: [
            mat.title,
            mat.fileName || '',
            mat.module?.title || '',
            course.code,
            course.title,
            mat.type,
          ],
        };
        const score = this.scoreItem(
          rawQuery,
          itemBase,
          ftsRanks.get(mat.id) || 0,
        );
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // 3. Notices (strictly enforcing audience scope & hidden status)
    if (shouldSearch('notice')) {
      const ftsRanks = await this.getFtsRankedIds(
        'Notice',
        `coalesce("title", '') || ' ' || coalesce("body", '') || ' ' || coalesce("targetCourseCode", '')`,
        rawQuery,
      );
      const ftsIds = Array.from(ftsRanks.keys());

      const notices = await this.prisma.notice.findMany({
        where: {
          isHidden: false,
          OR: [
            ...(ftsIds.length > 0 ? [{ id: { in: ftsIds } }] : []),
            ...searchTokens.flatMap((tok) => [
              { title: { contains: tok, mode: 'insensitive' as const } },
              { body: { contains: tok, mode: 'insensitive' as const } },
              {
                targetCourseCode: {
                  contains: tok,
                  mode: 'insensitive' as const,
                },
              },
            ]),
          ],
        },
        include: {
          author: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      for (const notice of notices) {
        if (!this.canUserSeeNotice(role, notice, userDeptCode, userDeptName, userLevel, userCourseCodes, user.id)) {
          continue;
        }

        const itemBase = {
          id: `notice-${notice.id}`,
          type: 'notice' as const,
          title: notice.title,
          subtitle: `${notice.isUrgent ? 'URGENT' : 'GENERAL'} • Posted by ${notice.author?.fullName || 'Faculty Staff'}`,
          snippet:
            notice.body.length > 140
              ? `${notice.body.slice(0, 140)}…`
              : notice.body,
          badge: notice.targetCourseCode || notice.scope.toUpperCase(),
          href: `/notices?highlight=${encodeURIComponent(notice.id)}`,
          keywords: [
            notice.title,
            notice.body,
            notice.author?.fullName || '',
            notice.targetCourseCode || '',
            notice.targetDepartmentCode || '',
          ],
        };
        const score = this.scoreItem(
          rawQuery,
          itemBase,
          ftsRanks.get(notice.id) || 0,
        );
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // 4. Assignments (strictly excluding private submissions & unpublished drafts for unauthorized users)
    if (shouldSearch('assignment')) {
      const ftsRanks = await this.getFtsRankedIds(
        'Assignment',
        `coalesce("title", '') || ' ' || coalesce("instructions", '')`,
        rawQuery,
      );
      const ftsIds = Array.from(ftsRanks.keys());

      const assignments = await this.prisma.assignment.findMany({
        where: {
          OR: [
            ...(ftsIds.length > 0 ? [{ id: { in: ftsIds } }] : []),
            ...searchTokens.flatMap((tok) => [
              { title: { contains: tok, mode: 'insensitive' as const } },
              { instructions: { contains: tok, mode: 'insensitive' as const } },
              {
                offering: {
                  course: {
                    code: { contains: tok, mode: 'insensitive' as const },
                  },
                },
              },
              {
                offering: {
                  course: {
                    title: { contains: tok, mode: 'insensitive' as const },
                  },
                },
              },
            ]),
          ],
        },
        include: {
          offering: {
            include: {
              course: true,
            },
          },
        },
        take: 80,
      });

      for (const assignment of assignments) {
        const course = assignment.offering.course;
        const canSeeAssignment = this.canUserSeeAssignment(
          role,
          assignment.status,
          assignment.offeringId,
          course.departmentId,
          course.level,
          userDeptId,
          userLevel,
          enrolledOfferingIds,
          lecturedOfferingIds,
        );
        if (!canSeeAssignment) {
          continue;
        }

        const dueLabel = assignment.deadline.toLocaleDateString('en-NG', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });

        const itemBase = {
          id: `assignment-${assignment.id}`,
          type: 'assignment' as const,
          title: `${course.code}: ${assignment.title}`,
          subtitle: `${course.title} • Due ${dueLabel}`,
          snippet:
            assignment.instructions.length > 135
              ? `${assignment.instructions.slice(0, 135)}…`
              : assignment.instructions,
          badge: course.code,
          href: `/assignments?course=${encodeURIComponent(course.code)}`,
          keywords: [
            assignment.title,
            assignment.instructions,
            course.code,
            course.title,
          ],
        };
        const score = this.scoreItem(
          rawQuery,
          itemBase,
          ftsRanks.get(assignment.id) || 0,
        );
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // 5. Past Questions (approved only for non-admin/non-HOD, soft-deleted excluded)
    if (shouldSearch('past_question')) {
      const ftsRanks = await this.getFtsRankedIds(
        'PastQuestion',
        `coalesce("courseCode", '') || ' ' || coalesce("session", '') || ' ' || coalesce("fileName", '')`,
        rawQuery,
      );
      const ftsIds = Array.from(ftsRanks.keys());

      const pastQuestions = await this.prisma.pastQuestion.findMany({
        where: {
          deletedAt: null,
          status: PastQuestionStatus.approved,
          OR: [
            ...(ftsIds.length > 0 ? [{ id: { in: ftsIds } }] : []),
            ...searchTokens.flatMap((tok) => [
              { courseCode: { contains: tok, mode: 'insensitive' as const } },
              { session: { contains: tok, mode: 'insensitive' as const } },
              { fileName: { contains: tok, mode: 'insensitive' as const } },
            ]),
          ],
        },
        include: {
          uploader: true,
        },
        take: 80,
      });

      for (const pq of pastQuestions) {
        const semesterLabel =
          pq.semester === 'first' ? 'First Semester' : 'Second Semester';
        const examLabel = pq.examType.replace(/_/g, ' ');
        const itemBase = {
          id: `pq-${pq.id}`,
          type: 'past_question' as const,
          title: `${pq.courseCode} Past Question (${pq.session})`,
          subtitle: `${semesterLabel} • ${examLabel}`,
          snippet: pq.fileName
            ? `File: ${pq.fileName} • Uploaded by ${pq.uploader?.fullName || 'Faculty'}`
            : `Approved past question for ${pq.courseCode}`,
          badge: `${pq.courseCode} • ${pq.session}`,
          href: `/past-questions?q=${encodeURIComponent(pq.courseCode)}`,
          keywords: [
            pq.courseCode,
            pq.session,
            semesterLabel,
            examLabel,
            pq.fileName || '',
          ],
        };
        const score = this.scoreItem(
          rawQuery,
          itemBase,
          ftsRanks.get(pq.id) || 0,
        );
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // 6. Calendar Events & Academic Periods
    if (shouldSearch('calendar')) {
      const [events, periods] = await Promise.all([
        this.prisma.calendarEvent.findMany({
          where: {
            OR: searchTokens.flatMap((tok) => [
              { title: { contains: tok, mode: 'insensitive' as const } },
              { location: { contains: tok, mode: 'insensitive' as const } },
              { courseCode: { contains: tok, mode: 'insensitive' as const } },
            ]),
          },
          take: 50,
        }),
        this.prisma.academicPeriod.findMany({
          where: {
            OR: searchTokens.flatMap((tok) => [
              { title: { contains: tok, mode: 'insensitive' as const } },
              { notes: { contains: tok, mode: 'insensitive' as const } },
            ]),
          },
          take: 30,
        }),
      ]);

      for (const event of events) {
        if (
          !this.canUserSeeCalendarEvent(
            role,
            event,
            userDeptCode,
            userDeptName,
            userLevel,
            userCourseCodes,
          )
        ) {
          continue;
        }
        const dateStr = event.start.toISOString().slice(0, 10);
        const itemBase = {
          id: `cal-event-${event.id}`,
          type: 'calendar' as const,
          title: event.title,
          subtitle: `${event.type.toUpperCase()} • ${dateStr}${event.location ? ` • ${event.location}` : ''}`,
          snippet: event.courseCode
            ? `Course: ${event.courseCode} • Scope: ${event.scope}`
            : `Scope: ${event.scope}`,
          badge: event.courseCode || event.type.toUpperCase(),
          href: `/calendar?date=${encodeURIComponent(dateStr)}`,
          keywords: [
            event.title,
            event.type,
            event.location || '',
            event.courseCode || '',
          ],
        };
        const score = this.scoreItem(rawQuery, itemBase, 0);
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }

      for (const period of periods) {
        const itemBase = {
          id: `cal-period-${period.id}`,
          type: 'calendar' as const,
          title: period.title,
          subtitle: `Academic Period • ${period.start} to ${period.end}`,
          snippet: period.notes || `${period.type} window`,
          badge: 'ACADEMIC CALENDAR',
          href: `/calendar?date=${encodeURIComponent(period.start)}`,
          keywords: [period.title, period.type, period.notes || ''],
        };
        const score = this.scoreItem(rawQuery, itemBase, 0);
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // 7. Faculty Staff Directory (ONLY active lecturer/hod — NEVER student records or private fields)
    if (shouldSearch('staff')) {
      const staffMembers = await this.prisma.user.findMany({
        where: {
          role: { in: [Role.lecturer, Role.hod] },
          status: UserStatus.active,
          OR: searchTokens.flatMap((tok) => [
            { fullName: { contains: tok, mode: 'insensitive' as const } },
            { email: { contains: tok, mode: 'insensitive' as const } },
            {
              department: {
                name: { contains: tok, mode: 'insensitive' as const },
              },
            },
            {
              department: {
                code: { contains: tok, mode: 'insensitive' as const },
              },
            },
          ]),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          department: {
            select: {
              code: true,
              name: true,
            },
          },
          lecturerOfferings: {
            select: {
              offering: {
                select: {
                  course: {
                    select: {
                      code: true,
                      title: true,
                    },
                  },
                },
              },
            },
          },
        },
        take: 50,
      });

      for (const staff of staffMembers) {
        const roleLabel =
          staff.role === Role.hod ? 'Head of Department (HOD)' : 'Lecturer';
        const taughtCodes = Array.from(
          new Set(
            staff.lecturerOfferings.map((lo) => lo.offering.course.code),
          ),
        );
        const deptName = staff.department?.name || 'Faculty of Computing';
        const itemBase = {
          id: `staff-${staff.id}`,
          type: 'staff' as const,
          title: staff.fullName,
          subtitle: `${roleLabel} • ${deptName}`,
          snippet:
            taughtCodes.length > 0
              ? `Courses: ${taughtCodes.join(', ')}${staff.email ? ` • ${staff.email}` : ''}`
              : staff.email || deptName,
          badge: staff.role === Role.hod ? 'HOD' : 'LECTURER',
          href: `/courses?q=${encodeURIComponent(staff.fullName)}`,
          keywords: [
            staff.fullName,
            roleLabel,
            deptName,
            staff.department?.code || '',
            staff.email || '',
            ...taughtCodes,
          ],
        };
        const score = this.scoreItem(rawQuery, itemBase, 0);
        if (score > 0) {
          results.push({ ...itemBase, score });
        }
      }
    }

    // Sort all matched items by relevance score descending, then title ascending
    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    const totalCount = results.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const pagedItems = results.slice(offset, offset + limit);

    const grouped: Record<SearchResultType, SearchResultItem[]> = {
      course: [],
      lesson: [],
      notice: [],
      past_question: [],
      assignment: [],
      calendar: [],
      staff: [],
    };
    for (const item of pagedItems) {
      grouped[item.type].push(item);
    }

    return {
      query: rawQuery,
      totalCount,
      page: safePage,
      limit,
      totalPages,
      hasMore: safePage < totalPages,
      items: pagedItems,
      grouped,
      indexedTypes: [
        'course',
        'lesson',
        'notice',
        'past_question',
        'assignment',
        'calendar',
        'staff',
      ],
      engine: 'postgres_fts_hybrid',
    };
  }

  private canUserSeeNotice(
    role: Role,
    notice: {
      authorId: string;
      scope: AudienceScope;
      targetDepartmentCode: string | null;
      targetLevel: number | null;
      targetCourseCode: string | null;
    },
    userDeptCode: string | null,
    userDeptName: string | null,
    userLevel: number | null,
    userCourseCodes: Set<string>,
    userId: string,
  ): boolean {
    if (role === Role.admin || notice.authorId === userId) {
      return true;
    }
    if (notice.scope === AudienceScope.faculty) {
      return true;
    }

    const matchesDept =
      !notice.targetDepartmentCode ||
      (userDeptCode &&
        notice.targetDepartmentCode.toLowerCase() ===
          userDeptCode.toLowerCase()) ||
      (userDeptName &&
        notice.targetDepartmentCode.toLowerCase() ===
          userDeptName.toLowerCase());

    if (notice.scope === AudienceScope.department) {
      return Boolean(matchesDept);
    }

    if (notice.scope === AudienceScope.level) {
      const matchesLevel =
        !notice.targetLevel ||
        !userLevel ||
        Number(notice.targetLevel) === Number(userLevel);
      return Boolean(matchesDept && matchesLevel);
    }

    if (notice.scope === AudienceScope.course) {
      if (!notice.targetCourseCode) return true;
      for (const code of userCourseCodes) {
        if (code.toLowerCase() === notice.targetCourseCode.toLowerCase()) {
          return true;
        }
      }
      return false;
    }

    return false;
  }

  private canUserSeeAssignment(
    role: Role,
    status: AssignmentStatus,
    offeringId: string,
    courseDepartmentId: string,
    courseLevel: number,
    userDeptId: string | null,
    userLevel: number | null,
    enrolledOfferingIds: Set<string>,
    lecturedOfferingIds: Set<string>,
  ): boolean {
    if (role === Role.admin) {
      return true;
    }

    if (role === Role.hod) {
      return Boolean(userDeptId && courseDepartmentId === userDeptId);
    }

    if (role === Role.lecturer) {
      if (lecturedOfferingIds.has(offeringId)) {
        return true;
      }
      return (
        status !== AssignmentStatus.draft &&
        Boolean(userDeptId && courseDepartmentId === userDeptId)
      );
    }

    // Student & course_rep: never see draft assignments; only see enrolled or matching dept/level
    if (status === AssignmentStatus.draft) {
      return false;
    }

    if (enrolledOfferingIds.has(offeringId)) {
      return true;
    }

    const sameDept = Boolean(userDeptId && courseDepartmentId === userDeptId);
    const sameLevel = !userLevel || Number(courseLevel) === Number(userLevel);
    return sameDept && sameLevel;
  }

  private canUserSeeCalendarEvent(
    role: Role,
    event: {
      scope: AudienceScope;
      targetDepartment: string | null;
      targetLevel: number | null;
      courseCode: string | null;
    },
    userDeptCode: string | null,
    userDeptName: string | null,
    userLevel: number | null,
    userCourseCodes: Set<string>,
  ): boolean {
    if (role === Role.admin || event.scope === AudienceScope.faculty) {
      return true;
    }

    const matchesDept =
      !event.targetDepartment ||
      (userDeptCode &&
        event.targetDepartment.toLowerCase() === userDeptCode.toLowerCase()) ||
      (userDeptName &&
        event.targetDepartment.toLowerCase() === userDeptName.toLowerCase());

    if (event.scope === AudienceScope.department) {
      return Boolean(matchesDept);
    }

    if (event.scope === AudienceScope.level) {
      const matchesLevel =
        !event.targetLevel ||
        !userLevel ||
        Number(event.targetLevel) === Number(userLevel);
      return Boolean(matchesDept && matchesLevel);
    }

    if (event.scope === AudienceScope.course) {
      if (!event.courseCode) return true;
      for (const code of userCourseCodes) {
        if (code.toLowerCase() === event.courseCode.toLowerCase()) {
          return true;
        }
      }
      return Boolean(matchesDept);
    }

    return true;
  }
}
