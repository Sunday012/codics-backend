import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AssignmentStatus,
  AudienceScope,
  MaterialStatus,
  MaterialType,
  PastQuestionStatus,
  Role,
  Semester,
  UserStatus,
} from '@prisma/client';
import { ProgressService } from './progress.service';
import { SearchService } from './search.service';

describe('Phase 6: Learning Progress & Global Search Services', () => {
  describe('ProgressService', () => {
    const mockMaterial = {
      id: 'mat-1',
      moduleId: 'mod-1',
      offeringId: 'off-1',
      type: MaterialType.pdf,
      title: 'Week 1: Relational Algebra Slides',
      status: MaterialStatus.published,
      deletedAt: null,
      module: {
        id: 'mod-1',
        title: 'Module 1: Foundations',
      },
      offering: {
        id: 'off-1',
        courseId: 'course-csc303',
        course: {
          id: 'course-csc303',
          code: 'CSC 303',
          title: 'Database Management Systems',
          departmentId: 'dept-csc',
        },
        lecturers: [{ userId: 'lect-1' }],
      },
    };

    const createProgressPrismaMock = () => {
      const store = new Map<string, any>();
      return {
        store,
        material: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.id === 'mat-1') return mockMaterial;
            if (where.id === 'mat-draft') {
              return {
                ...mockMaterial,
                id: 'mat-draft',
                status: MaterialStatus.draft,
              };
            }
            return null;
          }),
          findMany: jest.fn(async () => [
            { id: 'mat-1', offeringId: 'off-1' },
            { id: 'mat-2', offeringId: 'off-1' },
          ]),
        },
        offering: {
          findFirst: jest.fn(async () => ({
            id: 'off-1',
            course: mockMaterial.offering.course,
            materials: [
              { id: 'mat-1', module: mockMaterial.module },
              { id: 'mat-2', module: mockMaterial.module },
            ],
          })),
        },
        userMaterialProgress: {
          findUnique: jest.fn(async ({ where }: any) => {
            const key = `${where.userId_materialId.userId}:${where.userId_materialId.materialId}`;
            return store.get(key) || null;
          }),
          upsert: jest.fn(async ({ where, create, update }: any) => {
            const key = `${where.userId_materialId.userId}:${where.userId_materialId.materialId}`;
            const existing = store.get(key);
            const now = new Date();
            const next = existing
              ? {
                  ...existing,
                  ...update,
                  updatedAt: now,
                  material: mockMaterial,
                  offering: mockMaterial.offering,
                }
              : {
                  id: `prog-${store.size + 1}`,
                  ...create,
                  createdAt: now,
                  updatedAt: now,
                  material: mockMaterial,
                  offering: mockMaterial.offering,
                };
            store.set(key, next);
            return next;
          }),
          findMany: jest.fn(async ({ where }: any) => {
            return Array.from(store.values())
              .filter((r) => r.userId === where.userId)
              .sort(
                (a, b) =>
                  b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime(),
              );
          }),
        },
      };
    };

    it('persists material completion and computes Resume Learning state across devices', async () => {
      const prismaMock = createProgressPrismaMock();
      const service = new ProgressService(prismaMock as any);

      const student = {
        id: 'student-1',
        role: Role.student,
        departmentId: 'dept-csc',
      };

      const updated = await service.updateMaterialProgress(student, 'mat-1', {
        completed: true,
        lastAccessedAt: '2026-10-20T10:00:00.000Z',
      });

      expect(updated.completed).toBe(true);
      expect(updated.courseCode).toBe('CSC 303');
      expect(updated.materialTitle).toBe('Week 1: Relational Algebra Slides');

      const overview = await service.getUserProgress(student);
      expect(overview.items).toHaveLength(1);
      expect(overview.resumeLearning).not.toBeNull();
      expect(overview.resumeLearning?.courseCode).toBe('CSC 303');
      expect(overview.resumeLearning?.materialId).toBe('mat-1');
      expect(overview.resumeLearning?.progressPercent).toBe(50);
    });

    it('prevents a user from modifying another user progress or tracking draft materials', async () => {
      const prismaMock = createProgressPrismaMock();
      const service = new ProgressService(prismaMock as any);

      const studentA = {
        id: 'student-a',
        role: Role.student,
        departmentId: 'dept-csc',
      };
      const studentB = {
        id: 'student-b',
        role: Role.student,
        departmentId: 'dept-csc',
      };

      await expect(
        service.updateMaterialProgress(studentA, 'mat-1', {
          completed: true,
          userId: studentB.id,
        } as any),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.updateMaterialProgress(studentA, 'mat-draft', {
          completed: true,
        }),
      ).rejects.toThrow(ForbiddenException);

      // Verify studentB has zero records
      const bProgress = await service.getUserProgress(studentB);
      expect(bProgress.items).toHaveLength(0);
    });

    it('reconciles offline batch sync idempotently without falsely marking completed from stale mutations', async () => {
      const prismaMock = createProgressPrismaMock();
      const service = new ProgressService(prismaMock as any);

      const student = {
        id: 'student-1',
        role: Role.student,
        departmentId: 'dept-csc',
      };

      // First sync batch: material opened and completed at 09:00, then unchecked at 09:05
      const batchResult = await service.syncProgressBatch(student, {
        items: [
          {
            materialId: 'mat-1',
            completed: true,
            lastAccessedAt: '2026-10-20T09:00:00.000Z',
            clientUpdatedAt: '2026-10-20T09:00:00.000Z',
          },
          {
            materialId: 'mat-1',
            completed: false,
            lastAccessedAt: '2026-10-20T09:05:00.000Z',
            clientUpdatedAt: '2026-10-20T09:05:00.000Z',
          },
        ],
      });

      expect(batchResult.syncedCount).toBe(1);
      expect(batchResult.items[0].completed).toBe(false);

      // Now simulate a stale duplicate retry arriving with an older timestamp (08:30) trying to mark completed=true
      const staleRetryResult = await service.syncProgressBatch(student, {
        items: [
          {
            materialId: 'mat-1',
            completed: true,
            lastAccessedAt: '2026-10-20T08:30:00.000Z',
            clientUpdatedAt: '2026-10-20T08:30:00.000Z',
          },
        ],
      });

      // Must remain false because server state is newer than 08:30
      expect(staleRetryResult.items[0].completed).toBe(false);
    });
  });

  describe('SearchService', () => {
    const createSearchPrismaMock = () => ({
      $queryRawUnsafe: jest.fn(async () => []),
      user: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          role: Role.student,
          departmentId: 'dept-csc',
          level: 200,
          department: {
            id: 'dept-csc',
            code: 'CSC',
            name: 'Computer Science',
          },
        })),
        findMany: jest.fn(async () => [
          {
            id: 'staff-1',
            fullName: 'Dr. Adebayo Ogunleye',
            email: 'a.ogunleye@uniben.edu',
            role: Role.lecturer,
            department: { code: 'CSC', name: 'Computer Science' },
            lecturerOfferings: [
              {
                offering: {
                  course: {
                    code: 'CSC 201',
                    title: 'Computer Programming I',
                  },
                },
              },
            ],
          },
        ]),
      },
      enrollment: {
        findMany: jest.fn(async () => [
          {
            offeringId: 'off-csc201',
            offering: {
              id: 'off-csc201',
              course: {
                id: 'course-csc201',
                code: 'CSC 201',
                title: 'Computer Programming I',
              },
            },
          },
        ]),
      },
      offeringLecturer: {
        findMany: jest.fn(async () => []),
      },
      course: {
        findMany: jest.fn(async () => [
          {
            id: 'course-csc201',
            code: 'CSC 201',
            title: 'Computer Programming I',
            units: 3,
            level: 200,
            semester: Semester.first,
            department: { code: 'CSC', name: 'Computer Science' },
            offerings: [{ lecturers: [{ user: { fullName: 'Dr. Ogunleye' } }] }],
          },
        ]),
      },
      material: {
        findMany: jest.fn(async () => [
          {
            id: 'mat-pub',
            title: 'CSC 201 Pointer Arithmetic Notes',
            type: MaterialType.pdf,
            status: MaterialStatus.published,
            fileName: 'pointers.pdf',
            body: null,
            deletedAt: null,
            offeringId: 'off-csc201',
            module: { id: 'mod-1', title: 'Week 3', deletedAt: null },
            offering: {
              id: 'off-csc201',
              course: {
                id: 'course-csc201',
                code: 'CSC 201',
                title: 'Computer Programming I',
                departmentId: 'dept-csc',
              },
            },
          },
          {
            id: 'mat-secret-draft',
            title: 'CSC 201 Confidential Draft Exam Key',
            type: MaterialType.pdf,
            status: MaterialStatus.draft,
            fileName: 'exam-key.pdf',
            body: null,
            deletedAt: null,
            offeringId: 'off-csc201',
            module: { id: 'mod-1', title: 'Week 3', deletedAt: null },
            offering: {
              id: 'off-csc201',
              course: {
                id: 'course-csc201',
                code: 'CSC 201',
                title: 'Computer Programming I',
                departmentId: 'dept-csc',
              },
            },
          },
        ]),
      },
      notice: {
        findMany: jest.fn(async () => [
          {
            id: 'notice-csc',
            authorId: 'staff-1',
            title: 'CSC 201 Lab Venue Update',
            body: 'Practical holds in Lab B.',
            scope: AudienceScope.department,
            targetDepartmentCode: 'CSC',
            targetLevel: null,
            targetCourseCode: null,
            isUrgent: true,
            isHidden: false,
            author: { fullName: 'Dr. Ogunleye' },
          },
          {
            id: 'notice-cyb-only',
            authorId: 'staff-2',
            title: 'CSC Cyber Security Restricted Briefing',
            body: 'Strictly for Cyber Security department.',
            scope: AudienceScope.department,
            targetDepartmentCode: 'CYB',
            targetLevel: null,
            targetCourseCode: null,
            isUrgent: false,
            isHidden: false,
            author: { fullName: 'Dr. Bello' },
          },
        ]),
      },
      assignment: {
        findMany: jest.fn(async () => [
          {
            id: 'asgn-pub',
            offeringId: 'off-csc201',
            title: 'CSC 201 Linked List Lab',
            instructions: 'Implement a doubly linked list in C.',
            deadline: new Date('2026-11-15T23:59:00.000Z'),
            status: AssignmentStatus.published,
            offering: {
              id: 'off-csc201',
              course: {
                id: 'course-csc201',
                code: 'CSC 201',
                title: 'Computer Programming I',
                departmentId: 'dept-csc',
                level: 200,
              },
            },
          },
          {
            id: 'asgn-draft',
            offeringId: 'off-csc201',
            title: 'CSC 201 Unreleased Draft Assignment',
            instructions: 'Draft instructions',
            deadline: new Date('2026-11-20T23:59:00.000Z'),
            status: AssignmentStatus.draft,
            offering: {
              id: 'off-csc201',
              course: {
                id: 'course-csc201',
                code: 'CSC 201',
                title: 'Computer Programming I',
                departmentId: 'dept-csc',
                level: 200,
              },
            },
          },
        ]),
      },
      pastQuestion: {
        findMany: jest.fn(async () => [
          {
            id: 'pq-1',
            courseCode: 'CSC 201',
            session: '2024/2025',
            semester: Semester.first,
            examType: 'first_semester',
            fileName: 'csc201_2024.pdf',
            status: PastQuestionStatus.approved,
            deletedAt: null,
            uploader: { fullName: 'Dr. Ogunleye' },
          },
        ]),
      },
      calendarEvent: {
        findMany: jest.fn(async () => []),
      },
      academicPeriod: {
        findMany: jest.fn(async () => []),
      },
    });

    const authMock = {
      effectiveRole: jest.fn((u: any) => u.role || Role.student),
    };

    const studentUser: any = {
      id: 'student-1',
      role: Role.student,
      status: UserStatus.active,
      departmentId: 'dept-csc',
      level: 200,
    };

    it('validates search query minimum and maximum length', async () => {
      const prismaMock = createSearchPrismaMock();
      const service = new SearchService(prismaMock as any, authMock as any);

      await expect(service.search(studentUser, { q: 'a' })).rejects.toThrow(
        BadRequestException,
      );

      await expect(
        service.search(studentUser, { q: 'x'.repeat(105) }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns authorized results across categories while filtering out draft materials, draft assignments, and other-department notices', async () => {
      const prismaMock = createSearchPrismaMock();
      const service = new SearchService(prismaMock as any, authMock as any);

      const res = await service.search(studentUser, {
        q: 'CSC',
        page: '1',
        limit: '20',
      });

      expect(res.totalCount).toBeGreaterThanOrEqual(4);
      const ids = res.items.map((i) => i.id);

      // Authorized records are included
      expect(ids).toContain('course-course-csc201');
      expect(ids).toContain('lesson-mat-pub');
      expect(ids).toContain('notice-notice-csc');
      expect(ids).toContain('assignment-asgn-pub');
      expect(ids).toContain('pq-pq-1');

      // Unauthorized / draft / out-of-scope records are strictly excluded
      expect(ids).not.toContain('lesson-mat-secret-draft');
      expect(ids).not.toContain('notice-notice-cyb-only');
      expect(ids).not.toContain('assignment-asgn-draft');
    });

    it('paginates global search results accurately', async () => {
      const prismaMock = createSearchPrismaMock();
      const service = new SearchService(prismaMock as any, authMock as any);

      const page1 = await service.search(studentUser, {
        q: 'CSC',
        page: '1',
        limit: '2',
      });
      const page2 = await service.search(studentUser, {
        q: 'CSC',
        page: '2',
        limit: '2',
      });

      expect(page1.items).toHaveLength(2);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page2.page).toBe(2);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });
});
