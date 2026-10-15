import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { User } from '../data/entities';
import { PrismaService } from '../database/prisma.service';
import { MaterialDto, ModuleDto } from './courses.dto';

@Injectable()
export class CoursesService {
  constructor(private prisma: PrismaService) {}

  async list(user: User, query: { department?: string; level?: string; search?: string }) {
    const courses = await this.prisma.course.findMany({
      where: {
        ...(query.department && query.department !== 'all' ? { department: query.department } : {}),
        ...(query.level && query.level !== 'all' ? { level: query.level } : {}),
        ...(query.search ? { OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { title: { contains: query.search, mode: 'insensitive' } },
        ] } : {}),
      },
      include: { offerings: true, enrollments: { where: { userId: user.id }, select: { id: true } } },
      orderBy: { code: 'asc' },
    });
    return courses.map(({ enrollments, ...course }) => ({ ...course, isEnrolled: enrollments.length > 0 }));
  }

  async get(courseId: string, session?: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, include: { offerings: { where: session ? { session } : {} } } });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  async offering(id: string, user: User) {
    const canManage = await this.canManageOffering(user, id);
    const offering = await this.prisma.offering.findUnique({
      where: { id },
      include: { modules: { orderBy: { order: 'asc' }, include: { materials: { where: canManage ? {} : { status: 'published' }, orderBy: { createdAt: 'asc' } } } } },
    });
    if (!offering) throw new NotFoundException('Course offering not found');
    return { ...offering, canManage };
  }

  enrollments(user: User) {
    return this.prisma.enrollment.findMany({ where: { userId: user.id }, include: { offering: { include: { course: true } } }, orderBy: { createdAt: 'desc' } });
  }

  async createModule(offeringId: string, user: User, dto: ModuleDto) {
    await this.assertCanManage(user, offeringId);
    const module = await this.prisma.courseModule.create({ data: { offeringId, ...dto } });
    await this.prisma.audit(user, 'CREATE_MODULE', 'CourseModule', module.id, module.title);
    return module;
  }

  async removeModule(id: string, user: User) {
    const module = await this.prisma.courseModule.findUnique({ where: { id } });
    if (!module) throw new NotFoundException('Module not found');
    await this.assertCanManage(user, module.offeringId);
    await this.prisma.courseModule.delete({ where: { id } });
    await this.prisma.audit(user, 'DELETE_MODULE', 'CourseModule', id, module.title);
    return { success: true };
  }

  async createMaterial(moduleId: string, user: User, dto: MaterialDto) {
    const module = await this.prisma.courseModule.findUnique({ where: { id: moduleId } });
    if (!module) throw new NotFoundException('Module not found');
    await this.assertCanManage(user, module.offeringId);
    const material = await this.prisma.material.create({ data: { moduleId, offeringId: module.offeringId, ...dto, status: dto.status ?? 'draft' } });
    await this.prisma.audit(user, 'CREATE_MATERIAL', 'Material', material.id, material.title);
    return material;
  }

  async updateMaterial(id: string, user: User, dto: MaterialDto) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material) throw new NotFoundException('Material not found');
    await this.assertCanManage(user, material.offeringId);
    const updated = await this.prisma.material.update({ where: { id }, data: dto });
    await this.prisma.audit(user, 'UPDATE_MATERIAL', 'Material', id, dto.title);
    return updated;
  }

  async toggleMaterial(id: string, user: User) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material) throw new NotFoundException('Material not found');
    await this.assertCanManage(user, material.offeringId);
    return this.prisma.material.update({ where: { id }, data: { status: material.status === 'draft' ? 'published' : 'draft' } });
  }

  async removeMaterial(id: string, user: User) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material) throw new NotFoundException('Material not found');
    await this.assertCanManage(user, material.offeringId);
    await this.prisma.material.delete({ where: { id } });
    await this.prisma.audit(user, 'DELETE_MATERIAL', 'Material', id, material.title);
    return { success: true };
  }

  private async canManageOffering(user: User, offeringId: string) {
    if (['admin', 'hod'].includes(user.role)) return true;
    if (user.role !== 'lecturer') return false;
    return !!(await this.prisma.offering.findFirst({ where: { id: offeringId, lecturerIds: { has: user.id } }, select: { id: true } }));
  }

  private async assertCanManage(user: User, offeringId: string) {
    if (!(await this.canManageOffering(user, offeringId))) throw new ForbiddenException('You are not assigned to manage this course offering');
  }
}
