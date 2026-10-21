import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  FileCategory,
  MaterialStatus,
  MaterialType,
  Role,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import { SafeUser } from '../common/user.util';
import { PrismaService } from '../prisma/prisma.service';
import { MaterialDto, ModuleDto } from './courses.dto';

const MAX_MATERIAL_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  private extractMaterialFile(
    dto: MaterialDto,
    file?: Express.Multer.File,
  ): { buffer: Buffer; fileName: string; mimeType: string } | null {
    if (file && file.buffer && file.buffer.length > 0) {
      return {
        buffer: file.buffer,
        fileName: file.originalname || `${dto.title || 'material'}.pdf`,
        mimeType: file.mimetype || 'application/octet-stream',
      };
    }

    const content = dto.contentOrUrl?.trim() || '';
    if (content.startsWith('data:')) {
      const match = content.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) {
        throw new BadRequestException('Malformed data URI in material payload');
      }
      const mimeType = match[1].trim().toLowerCase();
      const base64Data = match[2].trim();
      const buffer = Buffer.from(base64Data, 'base64');
      const extMap: Record<string, string> = {
        'application/pdf': '.pdf',
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'application/zip': '.zip',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          '.pptx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          '.docx',
      };
      const ext =
        extMap[mimeType] || (dto.type === 'slides' ? '.pdf' : '.pdf');
      return {
        buffer,
        fileName: `${(dto.title || 'course-material').replace(/[^a-zA-Z0-9._-]/g, '_')}${ext}`,
        mimeType,
      };
    }

    return null;
  }

  async list(
    user: { id: string; role: Role; departmentId?: string | null },
    query: { department?: string; level?: string; search?: string },
  ) {
    const where: any = {};
    if (query.department && query.department !== 'all') {
      where.department = {
        OR: [{ name: query.department }, { code: query.department }],
      };
    }
    if (query.level && query.level !== 'all') {
      where.level = Number(query.level) || undefined;
    }
    if (query.search) {
      const search = query.search.trim();
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [courses, userEnrollments] = await Promise.all([
      this.prisma.course.findMany({
        where,
        include: {
          offerings: true,
          department: true,
        },
        orderBy: { code: 'asc' },
      }),
      this.prisma.enrollment.findMany({
        where: { userId: user.id },
        select: { offering: { select: { courseId: true } } },
      }),
    ]);

    const enrolledCourseIds = new Set(
      userEnrollments.map((e) => e.offering.courseId),
    );

    return courses.map((course) => ({
      id: course.id,
      code: course.code,
      title: course.title,
      units: course.units,
      unit: course.units,
      department: course.department.name,
      departmentId: course.departmentId,
      level: String(course.level),
      semester:
        course.semester === 'first' ? 'First Semester' : 'Second Semester',
      isEnrolled: enrolledCourseIds.has(course.id),
      offerings: course.offerings.map((o) => ({
        id: o.id,
        courseId: o.courseId,
        courseCode: course.code,
        session: o.session,
        semester:
          o.semester === 'first' ? 'First Semester' : 'Second Semester',
      })),
    }));
  }

  async get(courseId: string, session?: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        department: true,
        offerings: {
          where: session ? { session } : undefined,
          include: { lecturers: { include: { user: true } } },
        },
      },
    });

    if (!course) throw new NotFoundException('Course not found');

    return {
      id: course.id,
      code: course.code,
      title: course.title,
      unit: course.units,
      units: course.units,
      department: course.department.name,
      level: String(course.level),
      offerings: course.offerings.map((o) => ({
        id: o.id,
        courseId: o.courseId,
        courseCode: course.code,
        session: o.session,
        semester:
          o.semester === 'first' ? 'First Semester' : 'Second Semester',
        lecturerIds: o.lecturers.map((l) => l.userId),
        lecturerNames: o.lecturers.map((l) => l.user.fullName),
      })),
    };
  }

  async offering(
    id: string,
    user: { id: string; role: Role; departmentId?: string | null },
  ) {
    const offering = await this.prisma.offering.findUnique({
      where: { id },
      include: {
        course: true,
        lecturers: { include: { user: true } },
      },
    });

    if (!offering) throw new NotFoundException('Course offering not found');

    const canManage = await this.canManageOffering(user, id);

    // Soft-deleted modules are excluded by default
    const [modules, progressRecords] = await Promise.all([
      this.prisma.module.findMany({
        where: { offeringId: id, deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          materials: {
            where: {
              deletedAt: null,
              ...(canManage ? {} : { status: MaterialStatus.published }),
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      this.prisma.userMaterialProgress
        ? this.prisma.userMaterialProgress.findMany({
            where: { userId: user.id, offeringId: id },
          })
        : Promise.resolve([]),
    ]);

    const progressByMaterial = new Map<
      string,
      { completed: boolean; completedAt: Date | null; lastAccessedAt: Date }
    >(
      progressRecords.map((p: any) => [
        p.materialId,
        {
          completed: Boolean(p.completed),
          completedAt: p.completedAt || null,
          lastAccessedAt: p.lastAccessedAt,
        },
      ]),
    );

    const allMaterials = modules.flatMap((m) => m.materials);
    const completedCount = allMaterials.filter(
      (mat) => progressByMaterial.get(mat.id)?.completed,
    ).length;
    const progressPercent =
      allMaterials.length > 0
        ? Math.min(100, Math.round((completedCount / allMaterials.length) * 100))
        : 0;

    return {
      id: offering.id,
      courseId: offering.courseId,
      courseCode: offering.course.code,
      session: offering.session,
      semester:
        offering.semester === 'first' ? 'First Semester' : 'Second Semester',
      lecturerIds: offering.lecturers.map((l) => l.userId),
      lecturerNames: offering.lecturers.map((l) => l.user.fullName),
      progress: progressPercent,
      completedMaterials: completedCount,
      totalMaterials: allMaterials.length,
      modules: modules.map((m) => ({
        id: m.id,
        offeringId: m.offeringId,
        title: m.title,
        order: m.order,
        weekNumber: m.weekNumber,
        description: m.description,
        materials: m.materials.map((mat) => {
          const prog = progressByMaterial.get(mat.id);
          return {
            id: mat.id,
            moduleId: mat.moduleId,
            offeringId: mat.offeringId,
            title: mat.title,
            type: mat.type,
            fileKey: mat.fileKey,
            fileName: mat.fileName,
            fileSizeBytes: mat.sizeBytes,
            mimeType: (mat as any).mimeType,
            contentOrUrl:
              mat.url ||
              mat.body ||
              (mat.fileKey ? `/api/v1/materials/${mat.id}/download` : ''),
            url: mat.url,
            body: mat.body,
            status: mat.status,
            completed: Boolean(prog?.completed),
            completedAt: prog?.completedAt
              ? prog.completedAt.toISOString()
              : null,
            lastAccessedAt: prog?.lastAccessedAt
              ? prog.lastAccessedAt.toISOString()
              : null,
            createdAt: mat.createdAt.toISOString(),
          };
        }),
      })),
      canManage,
    };
  }

  async enrollments(user: { id: string }) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId: user.id },
      include: {
        offering: {
          include: { course: { include: { department: true } } },
        },
      },
    });

    return enrollments.map((e) => ({
      id: e.id,
      userId: e.userId,
      offeringId: e.offeringId,
      courseId: e.offering.courseId,
      courseCode: e.offering.course.code,
      type: e.type,
      session: e.offering.session,
      course: {
        id: e.offering.course.id,
        code: e.offering.course.code,
        title: e.offering.course.title,
        units: e.offering.course.units,
        unit: e.offering.course.units,
        department: e.offering.course.department.name,
        level: String(e.offering.course.level),
      },
    }));
  }

  async teachingOfferings(user: SafeUser) {
    const where: any =
      user.role === Role.lecturer
        ? { lecturers: { some: { userId: user.id } } }
        : user.departmentId
          ? { course: { departmentId: user.departmentId } }
          : {};

    const offerings = await this.prisma.offering.findMany({
      where,
      include: {
        course: { include: { department: true } },
        lecturers: { include: { user: true } },
        _count: {
          select: {
            enrollments: true,
            assignments: true,
            materials: true,
            attendanceSessions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return offerings.map((o) => ({
      id: o.id,
      courseId: o.courseId,
      courseCode: o.course.code,
      courseTitle: o.course.title,
      level: String(o.course.level),
      unit: o.course.units,
      department: o.course.department.name,
      session: o.session,
      semester: o.semester === 'first' ? 'First Semester' : 'Second Semester',
      enrolledCount: o._count.enrollments,
      assignmentCount: o._count.assignments,
      materialCount: o._count.materials,
      attendanceSessionCount: o._count.attendanceSessions,
      lecturers: o.lecturers.map((l) => ({
        id: l.user.id,
        name: l.user.fullName,
        email: l.user.email,
      })),
    }));
  }

  async createModule(
    offeringId: string,
    user: { id: string; fullName: string; role: Role; departmentId?: string | null },
    dto: ModuleDto,
  ) {
    await this.assertCanManage(user, offeringId);

    const module = await this.prisma.module.create({
      data: {
        offeringId,
        title: dto.title,
        order: dto.order,
        weekNumber: dto.weekNumber,
        description: dto.description,
      },
    });

    await this.audit.log(
      user,
      'CREATE_MODULE',
      'CourseModule',
      module.id,
      module.title,
    );
    return module;
  }

  async removeModule(
    id: string,
    user: { id: string; fullName: string; role: Role; departmentId?: string | null },
  ) {
    const module = await this.prisma.module.findUnique({ where: { id } });
    if (!module || module.deletedAt)
      throw new NotFoundException('Module not found');

    await this.assertCanManage(user, module.offeringId);

    // Soft delete module and materials in transaction
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.module.update({
        where: { id },
        data: { deletedAt: now },
      });
      await tx.material.updateMany({
        where: { moduleId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await this.audit.log(
        user,
        'DELETE_MODULE',
        'CourseModule',
        id,
        module.title,
        undefined,
        undefined,
        tx,
      );
    });

    return { success: true };
  }

  async createMaterial(
    moduleId: string,
    user: { id: string; fullName: string; role: Role; departmentId?: string | null },
    dto: MaterialDto,
    file?: Express.Multer.File,
  ) {
    const module = await this.prisma.module.findUnique({
      where: { id: moduleId },
    });
    if (!module || module.deletedAt)
      throw new NotFoundException('Module not found');

    await this.assertCanManage(user, module.offeringId);

    const extracted = this.extractMaterialFile(dto, file);
    let uploadedMeta: {
      fileKey: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
    } | null = null;

    if (extracted && this.storage) {
      uploadedMeta = await this.storage.uploadCategorizedObject({
        category: FileCategory.course_material,
        subFolder: module.offeringId,
        originalName: extracted.fileName,
        buffer: extracted.buffer,
        mimeType: extracted.mimeType,
        maxSizeBytes: MAX_MATERIAL_SIZE_BYTES,
        uploaderId: user.id,
      });
    }

    try {
      const isHttpUrl = Boolean(dto.contentOrUrl?.startsWith('http'));
      const material = await this.prisma.material.create({
        data: {
          moduleId,
          offeringId: module.offeringId,
          title: dto.title,
          type: (dto.type as MaterialType) || MaterialType.note,
          status: (dto.status as MaterialStatus) || MaterialStatus.draft,
          fileKey: uploadedMeta?.fileKey ?? undefined,
          fileName: uploadedMeta?.fileName ?? undefined,
          sizeBytes: uploadedMeta?.sizeBytes ?? dto.fileSizeBytes ?? undefined,
          mimeType: uploadedMeta?.mimeType ?? undefined,
          sha256: uploadedMeta?.sha256 ?? undefined,
          uploaderId: user.id,
          url: isHttpUrl ? dto.contentOrUrl : undefined,
          // Never store binary/data-URI payloads in PostgreSQL when object storage is active
          body:
            !isHttpUrl && !extracted
              ? dto.contentOrUrl
              : !this.storage && !isHttpUrl
                ? dto.contentOrUrl
                : undefined,
        },
      });

      if (uploadedMeta && this.storage) {
        await this.storage.linkStoredFileRecord(
          uploadedMeta.fileKey,
          material.id,
        );
      }

      await this.audit.log(
        user,
        'CREATE_MATERIAL',
        'Material',
        material.id,
        material.title,
      );

      return {
        ...material,
        fileSizeBytes: material.sizeBytes,
        contentOrUrl:
          material.url ||
          material.body ||
          (material.fileKey ? `/api/v1/materials/${material.id}/download` : ''),
        createdAt: material.createdAt.toISOString(),
      };
    } catch (err) {
      if (uploadedMeta && this.storage) {
        await this.storage.deleteCategorizedObject(uploadedMeta.fileKey);
      }
      throw err;
    }
  }

  async updateMaterial(
    id: string,
    user: { id: string; fullName: string; role: Role; departmentId?: string | null },
    dto: MaterialDto,
    file?: Express.Multer.File,
  ) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material || material.deletedAt)
      throw new NotFoundException('Material not found');

    await this.assertCanManage(user, material.offeringId);

    const extracted = this.extractMaterialFile(dto, file);
    let uploadedMeta: {
      fileKey: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
    } | null = null;

    if (extracted && this.storage) {
      uploadedMeta = await this.storage.uploadCategorizedObject({
        category: FileCategory.course_material,
        subFolder: material.offeringId,
        originalName: extracted.fileName,
        buffer: extracted.buffer,
        mimeType: extracted.mimeType,
        maxSizeBytes: MAX_MATERIAL_SIZE_BYTES,
        uploaderId: user.id,
        linkedRecordId: material.id,
      });
    }

    try {
      const isHttpUrl = Boolean(dto.contentOrUrl?.startsWith('http'));
      const updated = await this.prisma.material.update({
        where: { id },
        data: {
          title: dto.title,
          type: dto.type ? (dto.type as MaterialType) : undefined,
          status: dto.status ? (dto.status as MaterialStatus) : undefined,
          ...(uploadedMeta
            ? {
                fileKey: uploadedMeta.fileKey,
                fileName: uploadedMeta.fileName,
                sizeBytes: uploadedMeta.sizeBytes,
                mimeType: uploadedMeta.mimeType,
                sha256: uploadedMeta.sha256,
                uploaderId: user.id,
                body: null,
              }
            : {
                url: isHttpUrl ? dto.contentOrUrl : undefined,
                body: !isHttpUrl && !extracted ? dto.contentOrUrl : undefined,
              }),
        },
      });

      // Clean up old replaced file if a new file was uploaded
      if (uploadedMeta && material.fileKey && material.fileKey !== uploadedMeta.fileKey && this.storage) {
        await this.storage.deleteCategorizedObject(material.fileKey);
      }

      await this.audit.log(
        user,
        'UPDATE_MATERIAL',
        'Material',
        id,
        updated.title,
      );
      return {
        ...updated,
        fileSizeBytes: updated.sizeBytes,
        contentOrUrl:
          updated.url ||
          updated.body ||
          (updated.fileKey ? `/api/v1/materials/${updated.id}/download` : ''),
        updatedAt: updated.updatedAt.toISOString(),
      };
    } catch (err) {
      if (uploadedMeta && this.storage) {
        await this.storage.deleteCategorizedObject(uploadedMeta.fileKey);
      }
      throw err;
    }
  }

  async toggleMaterial(
    id: string,
    user: { id: string; fullName: string; role: Role; departmentId?: string | null },
  ) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material || material.deletedAt)
      throw new NotFoundException('Material not found');

    await this.assertCanManage(user, material.offeringId);

    const nextStatus =
      material.status === MaterialStatus.draft
        ? MaterialStatus.published
        : MaterialStatus.draft;

    const updated = await this.prisma.material.update({
      where: { id },
      data: { status: nextStatus },
    });

    await this.audit.log(
      user,
      'TOGGLE_MATERIAL_STATUS',
      'Material',
      id,
      `${material.title} -> ${nextStatus}`,
    );

    return {
      ...updated,
      contentOrUrl:
        updated.url ||
        updated.body ||
        (updated.fileKey ? `/api/v1/materials/${updated.id}/download` : ''),
    };
  }

  async removeMaterial(
    id: string,
    user: { id: string; fullName: string; role: Role; departmentId?: string | null },
  ) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material || material.deletedAt)
      throw new NotFoundException('Material not found');

    await this.assertCanManage(user, material.offeringId);

    // Soft delete material and clear file reference
    await this.prisma.material.update({
      where: { id },
      data: { deletedAt: new Date(), fileKey: null },
    });

    if (material.fileKey && this.storage) {
      await this.storage.deleteCategorizedObject(material.fileKey);
    }

    await this.audit.log(
      user,
      'DELETE_MATERIAL',
      'Material',
      id,
      material.title,
    );
    return { success: true };
  }

  /**
   * Retrieves a course material file for download after verifying role,
   * published status, and student course enrollment.
   */
  async getMaterialFile(
    id: string,
    user: { id: string; role: Role; departmentId?: string | null },
  ) {
    const material = await this.prisma.material.findUnique({
      where: { id },
    });

    if (!material || material.deletedAt) {
      throw new NotFoundException('Course material not found');
    }

    const canManage = await this.canManageOffering(user, material.offeringId);

    if (!canManage) {
      if (material.status === MaterialStatus.draft) {
        throw new ForbiddenException(
          'Draft course materials are not accessible to students',
        );
      }

      // Students and course reps must be enrolled in the course offering
      if (user.role === Role.student || user.role === Role.course_rep) {
        const enrollment = await this.prisma.enrollment.findUnique({
          where: {
            offeringId_userId: {
              offeringId: material.offeringId,
              userId: user.id,
            },
          },
        });
        if (!enrollment) {
          throw new ForbiddenException(
            'You must be enrolled in this course offering to access its materials',
          );
        }
      } else {
        throw new ForbiddenException(
          'You are not authorized to access materials for this course offering',
        );
      }
    }

    if (!material.fileKey || !this.storage) {
      throw new NotFoundException('No downloadable file attached to this material');
    }

    const buffer = await this.storage.getObject(material.fileKey);
    const presignedUrl = await this.storage.getPresignedDownloadUrl(
      material.fileKey,
      undefined,
      material.fileName || `${material.title}.pdf`,
    );

    return {
      buffer,
      fileName: material.fileName || `${material.title}.pdf`,
      mimeType: (material as any).mimeType || 'application/pdf',
      sizeBytes: material.sizeBytes || buffer.length,
      presignedUrl,
    };
  }

  private async canManageOffering(
    user: { id: string; role: Role; departmentId?: string | null },
    offeringId: string,
  ) {
    if (user.role === Role.admin) return true;
    if (user.role === Role.hod) {
      if (!user.departmentId) return false;
      const offering = await this.prisma.offering.findUnique({
        where: { id: offeringId },
        include: { course: true },
      });
      return offering?.course.departmentId === user.departmentId;
    }
    if (user.role === Role.lecturer) {
      const assigned = await this.prisma.offeringLecturer.findUnique({
        where: {
          offeringId_userId: { offeringId, userId: user.id },
        },
      });
      return !!assigned;
    }
    return false;
  }

  private async assertCanManage(
    user: { id: string; role: Role; departmentId?: string | null },
    offeringId: string,
  ) {
    const can = await this.canManageOffering(user, offeringId);
    if (!can) {
      throw new ForbiddenException(
        'You are not authorized to manage this course offering',
      );
    }
  }
}
