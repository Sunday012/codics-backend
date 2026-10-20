import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MaterialStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  SyncMaterialProgressBatchDto,
  UpdateMaterialProgressDto,
} from './progress.dto';

export interface MaterialProgressSummary {
  id: string;
  userId: string;
  materialId: string;
  offeringId: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  moduleId: string;
  moduleTitle: string;
  materialTitle: string;
  materialType: string;
  completed: boolean;
  completedAt: string | null;
  lastAccessedAt: string;
  updatedAt: string;
}

export interface CourseProgressOverview {
  offeringId: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  completedMaterials: number;
  totalMaterials: number;
  progressPercent: number;
  lastAccessedAt: string | null;
  lastMaterialId: string | null;
  lastMaterialTitle: string | null;
  lastModuleTitle: string | null;
}

export interface ResumeLearningState {
  offeringId: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  moduleId: string;
  moduleTitle: string;
  materialId: string;
  materialTitle: string;
  materialType: string;
  completed: boolean;
  lastAccessedAt: string;
  completedMaterials: number;
  totalMaterials: number;
  progressPercent: number;
}

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  private async canAccessMaterial(
    user: { id: string; role: Role; departmentId?: string | null },
    material: {
      id: string;
      status: MaterialStatus;
      deletedAt: Date | null;
      offeringId: string;
      offering: {
        id: string;
        course: { id: string; departmentId: string };
        lecturers?: { userId: string }[];
      };
    },
  ): Promise<boolean> {
    if (material.deletedAt) {
      return false;
    }

    if (user.role === Role.admin) {
      return true;
    }

    const isLecturer = material.offering.lecturers?.some(
      (l) => l.userId === user.id,
    );
    const isDeptHod =
      user.role === Role.hod &&
      Boolean(user.departmentId) &&
      user.departmentId === material.offering.course.departmentId;

    if (material.status === MaterialStatus.draft) {
      return Boolean(isLecturer || isDeptHod);
    }

    return true;
  }

  private mapProgressItem(record: any): MaterialProgressSummary {
    return {
      id: record.id,
      userId: record.userId,
      materialId: record.materialId,
      offeringId: record.offeringId,
      courseId: record.offering?.course?.id || record.offering?.courseId || '',
      courseCode: record.offering?.course?.code || '',
      courseTitle: record.offering?.course?.title || '',
      moduleId: record.material?.moduleId || record.material?.module?.id || '',
      moduleTitle: record.material?.module?.title || 'Course Module',
      materialTitle: record.material?.title || 'Course Material',
      materialType: record.material?.type || 'pdf',
      completed: Boolean(record.completed),
      completedAt: record.completedAt
        ? record.completedAt.toISOString()
        : null,
      lastAccessedAt: record.lastAccessedAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getUserProgress(user: {
    id: string;
    role: Role;
    departmentId?: string | null;
  }) {
    const records = await this.prisma.userMaterialProgress.findMany({
      where: {
        userId: user.id,
        material: {
          deletedAt: null,
          ...(user.role === Role.student || user.role === Role.course_rep
            ? { status: MaterialStatus.published }
            : {}),
        },
      },
      include: {
        material: {
          include: {
            module: true,
          },
        },
        offering: {
          include: {
            course: true,
          },
        },
      },
      orderBy: {
        lastAccessedAt: 'desc',
      },
    });

    const items = records.map((r) => this.mapProgressItem(r));

    const offeringIds = Array.from(new Set(records.map((r) => r.offeringId)));
    const offeringMaterials =
      offeringIds.length > 0
        ? await this.prisma.material.findMany({
            where: {
              offeringId: { in: offeringIds },
              deletedAt: null,
              status: MaterialStatus.published,
            },
            select: {
              id: true,
              offeringId: true,
            },
          })
        : [];

    const totalByOffering = new Map<string, Set<string>>();
    for (const mat of offeringMaterials) {
      const set = totalByOffering.get(mat.offeringId) || new Set<string>();
      set.add(mat.id);
      totalByOffering.set(mat.offeringId, set);
    }

    const coursesByOffering = new Map<string, CourseProgressOverview>();
    for (const item of items) {
      const publishedSet = totalByOffering.get(item.offeringId) || new Set();
      const totalMaterials = Math.max(publishedSet.size, 1);
      const existing = coursesByOffering.get(item.offeringId);

      if (!existing) {
        const completedCount = items.filter(
          (i) => i.offeringId === item.offeringId && i.completed,
        ).length;
        const progressPercent = Math.min(
          100,
          Math.round((completedCount / totalMaterials) * 100),
        );
        coursesByOffering.set(item.offeringId, {
          offeringId: item.offeringId,
          courseId: item.courseId,
          courseCode: item.courseCode,
          courseTitle: item.courseTitle,
          completedMaterials: completedCount,
          totalMaterials,
          progressPercent,
          lastAccessedAt: item.lastAccessedAt,
          lastMaterialId: item.materialId,
          lastMaterialTitle: item.materialTitle,
          lastModuleTitle: item.moduleTitle,
        });
      }
    }

    const latest = items[0] || null;
    const latestCourseOverview = latest
      ? coursesByOffering.get(latest.offeringId)
      : null;

    const resumeLearning: ResumeLearningState | null =
      latest && latestCourseOverview
        ? {
            offeringId: latest.offeringId,
            courseId: latest.courseId,
            courseCode: latest.courseCode,
            courseTitle: latest.courseTitle,
            moduleId: latest.moduleId,
            moduleTitle: latest.moduleTitle,
            materialId: latest.materialId,
            materialTitle: latest.materialTitle,
            materialType: latest.materialType,
            completed: latest.completed,
            lastAccessedAt: latest.lastAccessedAt,
            completedMaterials: latestCourseOverview.completedMaterials,
            totalMaterials: latestCourseOverview.totalMaterials,
            progressPercent: latestCourseOverview.progressPercent,
          }
        : null;

    return {
      items,
      courseOverviews: Array.from(coursesByOffering.values()),
      resumeLearning,
    };
  }

  async getOfferingProgress(
    user: { id: string; role: Role; departmentId?: string | null },
    offeringIdOrCourseCode: string,
  ) {
    const offering = await this.prisma.offering.findFirst({
      where: {
        OR: [
          { id: offeringIdOrCourseCode },
          { courseId: offeringIdOrCourseCode },
          {
            course: {
              code: { equals: offeringIdOrCourseCode, mode: 'insensitive' },
            },
          },
        ],
      },
      include: {
        course: true,
        materials: {
          where: {
            deletedAt: null,
            status: MaterialStatus.published,
          },
          include: {
            module: true,
          },
        },
      },
    });

    if (!offering) {
      throw new NotFoundException('Course offering not found');
    }

    const records = await this.prisma.userMaterialProgress.findMany({
      where: {
        userId: user.id,
        offeringId: offering.id,
        material: {
          deletedAt: null,
        },
      },
      include: {
        material: {
          include: {
            module: true,
          },
        },
        offering: {
          include: {
            course: true,
          },
        },
      },
      orderBy: {
        lastAccessedAt: 'desc',
      },
    });

    const items = records.map((r) => this.mapProgressItem(r));
    const publishedIds = new Set(offering.materials.map((m) => m.id));
    const completedMaterials = items.filter(
      (i) => i.completed && (publishedIds.has(i.materialId) || publishedIds.size === 0),
    ).length;
    const totalMaterials = offering.materials.length;
    const progressPercent =
      totalMaterials > 0
        ? Math.min(100, Math.round((completedMaterials / totalMaterials) * 100))
        : 0;
    const latest = items[0] || null;

    return {
      offeringId: offering.id,
      courseId: offering.course.id,
      courseCode: offering.course.code,
      courseTitle: offering.course.title,
      completedMaterials,
      totalMaterials,
      progressPercent,
      lastAccessedAt: latest?.lastAccessedAt || null,
      lastMaterialId: latest?.materialId || null,
      lastMaterialTitle: latest?.materialTitle || null,
      lastModuleTitle: latest?.moduleTitle || null,
      items,
    };
  }

  async updateMaterialProgress(
    user: {
      id: string;
      role: Role;
      departmentId?: string | null;
      targetUserId?: string;
    },
    materialId: string,
    dto: UpdateMaterialProgressDto,
  ): Promise<MaterialProgressSummary> {
    if (
      (dto as any)?.userId &&
      String((dto as any).userId).trim() !== user.id
    ) {
      throw new ForbiddenException(
        'Cannot modify learning progress belonging to another user',
      );
    }

    const material = await this.prisma.material.findUnique({
      where: { id: materialId },
      include: {
        module: true,
        offering: {
          include: {
            course: true,
            lecturers: true,
          },
        },
      },
    });

    if (!material || material.deletedAt) {
      throw new NotFoundException('Material not found');
    }

    const allowed = await this.canAccessMaterial(user, material);
    if (!allowed) {
      throw new ForbiddenException(
        'You do not have permission to track progress on this unpublished material',
      );
    }

    const existing = await this.prisma.userMaterialProgress.findUnique({
      where: {
        userId_materialId: {
          userId: user.id,
          materialId: material.id,
        },
      },
    });

    const now = new Date();
    const requestedAccessedAt = dto.lastAccessedAt
      ? new Date(dto.lastAccessedAt)
      : now;
    if (Number.isNaN(requestedAccessedAt.getTime())) {
      throw new BadRequestException('Invalid lastAccessedAt timestamp');
    }

    const clientUpdatedAt = dto.clientUpdatedAt
      ? new Date(dto.clientUpdatedAt)
      : now;

    // Reconcile safely: if an older offline mutation arrives after a newer server state,
    // preserve the newer completion state so duplicate/stale sync never clobbers or falsely marks completed.
    const isStaleCompletionUpdate =
      existing &&
      dto.clientUpdatedAt &&
      !Number.isNaN(clientUpdatedAt.getTime()) &&
      existing.updatedAt.getTime() > clientUpdatedAt.getTime();

    const nextCompleted =
      typeof dto.completed === 'boolean' && !isStaleCompletionUpdate
        ? dto.completed
        : (existing?.completed ?? false);

    const nextCompletedAt = nextCompleted
      ? existing?.completedAt || now
      : null;

    const nextLastAccessedAt =
      existing && existing.lastAccessedAt > requestedAccessedAt
        ? existing.lastAccessedAt
        : requestedAccessedAt;

    const upserted = await this.prisma.userMaterialProgress.upsert({
      where: {
        userId_materialId: {
          userId: user.id,
          materialId: material.id,
        },
      },
      create: {
        userId: user.id,
        materialId: material.id,
        offeringId: material.offeringId,
        completed: nextCompleted,
        completedAt: nextCompletedAt,
        lastAccessedAt: nextLastAccessedAt,
      },
      update: {
        completed: nextCompleted,
        completedAt: nextCompletedAt,
        lastAccessedAt: nextLastAccessedAt,
      },
      include: {
        material: {
          include: {
            module: true,
          },
        },
        offering: {
          include: {
            course: true,
          },
        },
      },
    });

    return this.mapProgressItem(upserted);
  }

  async syncProgressBatch(
    user: { id: string; role: Role; departmentId?: string | null },
    dto: SyncMaterialProgressBatchDto,
  ) {
    if (!dto || !Array.isArray(dto.items)) {
      throw new BadRequestException('Sync batch items array is required');
    }

    // Deduplicate by materialId keeping the latest clientUpdatedAt per material
    const dedupedByMaterial = new Map<string, (typeof dto.items)[number]>();
    for (const item of dto.items) {
      if (!item?.materialId) continue;
      const existing = dedupedByMaterial.get(item.materialId);
      if (!existing) {
        dedupedByMaterial.set(item.materialId, item);
        continue;
      }
      const existingTime = new Date(existing.clientUpdatedAt).getTime() || 0;
      const candidateTime = new Date(item.clientUpdatedAt).getTime() || 0;
      if (candidateTime >= existingTime) {
        dedupedByMaterial.set(item.materialId, {
          ...existing,
          ...item,
          completed:
            typeof item.completed === 'boolean'
              ? item.completed
              : existing.completed,
          lastAccessedAt: item.lastAccessedAt || existing.lastAccessedAt,
        });
      }
    }

    const synced: MaterialProgressSummary[] = [];
    const skipped: { materialId: string; reason: string }[] = [];

    for (const [materialId, item] of dedupedByMaterial.entries()) {
      try {
        const result = await this.updateMaterialProgress(user, materialId, {
          completed: item.completed,
          lastAccessedAt: item.lastAccessedAt,
          clientUpdatedAt: item.clientUpdatedAt,
        });
        synced.push(result);
      } catch (err: any) {
        skipped.push({
          materialId,
          reason: err?.message || 'Unable to reconcile material progress',
        });
      }
    }

    const overview = await this.getUserProgress(user);
    return {
      syncedCount: synced.length,
      skippedCount: skipped.length,
      skipped,
      synced,
      ...overview,
    };
  }
}
