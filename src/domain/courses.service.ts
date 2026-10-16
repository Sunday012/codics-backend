import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { Role, MaterialStatus, MaterialType } from '@prisma/client';
import { MaterialDto, ModuleDto } from './courses.dto';

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
      semester: course.semester === 'first' ? 'First Semester' : 'Second Semester',
      isEnrolled: enrolledCourseIds.has(course.id),
      offerings: course.offerings.map((o) => ({
        id: o.id,
        courseId: o.courseId,
        courseCode: course.code,
        session: o.session,
        semester: o.semester === 'first' ? 'First Semester' : 'Second Semester',
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
        semester: o.semester === 'first' ? 'First Semester' : 'Second Semester',
        lecturerIds: o.lecturers.map((l) => l.userId),
        lecturerNames: o.lecturers.map((l) => l.user.fullName),
      })),
    };
  }

  async offering(id: string, user: { id: string; role: Role }) {
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
    const modules = await this.prisma.module.findMany({
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
    });

    return {
      id: offering.id,
      courseId: offering.courseId,
      courseCode: offering.course.code,
      session: offering.session,
      semester: offering.semester === 'first' ? 'First Semester' : 'Second Semester',
      lecturerIds: offering.lecturers.map((l) => l.userId),
      lecturerNames: offering.lecturers.map((l) => l.user.fullName),
      modules: modules.map((m) => ({
        id: m.id,
        offeringId: m.offeringId,
        title: m.title,
        order: m.order,
        weekNumber: m.weekNumber,
        description: m.description,
        materials: m.materials.map((mat) => ({
          id: mat.id,
          moduleId: mat.moduleId,
          offeringId: mat.offeringId,
          title: mat.title,
          type: mat.type,
          contentOrUrl: mat.url || mat.body || '',
          url: mat.url,
          body: mat.body,
          status: mat.status,
          createdAt: mat.createdAt.toISOString(),
        })),
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

  async createModule(
    offeringId: string,
    user: { id: string; fullName: string; role: Role },
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

    await this.audit.log(user, 'CREATE_MODULE', 'CourseModule', module.id, module.title);
    return module;
  }

  async removeModule(
    id: string,
    user: { id: string; fullName: string; role: Role },
  ) {
    const module = await this.prisma.module.findUnique({ where: { id } });
    if (!module || module.deletedAt) throw new NotFoundException('Module not found');

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
    user: { id: string; fullName: string; role: Role },
    dto: MaterialDto,
  ) {
    const module = await this.prisma.module.findUnique({ where: { id: moduleId } });
    if (!module || module.deletedAt) throw new NotFoundException('Module not found');

    await this.assertCanManage(user, module.offeringId);

    const material = await this.prisma.material.create({
      data: {
        moduleId,
        offeringId: module.offeringId,
        title: dto.title,
        type: (dto.type as MaterialType) || MaterialType.note,
        status: (dto.status as MaterialStatus) || MaterialStatus.draft,
        url: dto.contentOrUrl?.startsWith('http') ? dto.contentOrUrl : undefined,
        body: !dto.contentOrUrl?.startsWith('http') ? dto.contentOrUrl : undefined,
      },
    });

    await this.audit.log(user, 'CREATE_MATERIAL', 'Material', material.id, material.title);
    return {
      ...material,
      contentOrUrl: material.url || material.body || '',
      createdAt: material.createdAt.toISOString(),
    };
  }

  async updateMaterial(
    id: string,
    user: { id: string; fullName: string; role: Role },
    dto: MaterialDto,
  ) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material || material.deletedAt) throw new NotFoundException('Material not found');

    await this.assertCanManage(user, material.offeringId);

    const updated = await this.prisma.material.update({
      where: { id },
      data: {
        title: dto.title,
        type: dto.type ? (dto.type as MaterialType) : undefined,
        status: dto.status ? (dto.status as MaterialStatus) : undefined,
        url: dto.contentOrUrl?.startsWith('http') ? dto.contentOrUrl : undefined,
        body: !dto.contentOrUrl?.startsWith('http') ? dto.contentOrUrl : undefined,
      },
    });

    await this.audit.log(user, 'UPDATE_MATERIAL', 'Material', id, updated.title);
    return {
      ...updated,
      contentOrUrl: updated.url || updated.body || '',
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async toggleMaterial(
    id: string,
    user: { id: string; fullName: string; role: Role },
  ) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material || material.deletedAt) throw new NotFoundException('Material not found');

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
      contentOrUrl: updated.url || updated.body || '',
    };
  }

  async removeMaterial(
    id: string,
    user: { id: string; fullName: string; role: Role },
  ) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material || material.deletedAt) throw new NotFoundException('Material not found');

    await this.assertCanManage(user, material.offeringId);

    // Soft delete material
    await this.prisma.material.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.log(user, 'DELETE_MATERIAL', 'Material', id, material.title);
    return { success: true };
  }

  private async canManageOffering(user: { id: string; role: Role }, offeringId: string) {
    if (['admin', 'hod'].includes(user.role)) return true;
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

  private async assertCanManage(user: { id: string; role: Role }, offeringId: string) {
    const can = await this.canManageOffering(user, offeringId);
    if (!can) {
      throw new ForbiddenException(
        'You are not assigned to manage this course offering',
      );
    }
  }
}
