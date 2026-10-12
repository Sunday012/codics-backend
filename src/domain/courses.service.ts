import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataService } from '../data/data.service';
import { CourseModule, Material, User } from '../data/entities';
import { MaterialDto, ModuleDto } from './courses.dto';

@Injectable()
export class CoursesService {
  constructor(private data: DataService) {}

  list(user: User, query: { department?: string; level?: string; search?: string }) {
    const enrolledIds = new Set(this.data.db.enrollments.filter((e) => e.userId === user.id).map((e) => e.courseId));
    let courses = this.data.db.courses.filter((course) => {
      if (query.department && query.department !== 'all' && course.department !== query.department) return false;
      if (query.level && query.level !== 'all' && course.level !== query.level) return false;
      if (query.search && !`${course.code} ${course.title}`.toLowerCase().includes(query.search.toLowerCase())) return false;
      return true;
    });
    return courses.map((course) => ({ ...course, isEnrolled: enrolledIds.has(course.id), offerings: this.data.db.offerings.filter((o) => o.courseId === course.id) }));
  }

  get(courseId: string, session?: string) {
    const course = this.data.db.courses.find((c) => c.id === courseId);
    if (!course) throw new NotFoundException('Course not found');
    const offerings = this.data.db.offerings.filter((o) => o.courseId === courseId && (!session || o.session === session));
    return { ...course, offerings };
  }

  offering(id: string, user: User) {
    const offering = this.data.db.offerings.find((o) => o.id === id);
    if (!offering) throw new NotFoundException('Course offering not found');
    const modules = this.data.db.modules.filter((m) => m.offeringId === id).sort((a, b) => a.order - b.order);
    const canManage = this.canManageOffering(user, id);
    return {
      ...offering,
      modules: modules.map((module) => ({
        ...module,
        materials: this.data.db.materials.filter((material) => material.moduleId === module.id && (canManage || material.status === 'published')),
      })),
      canManage,
    };
  }

  enrollments(user: User) {
    return this.data.db.enrollments.filter((e) => e.userId === user.id).map((e) => ({ ...e, course: this.data.db.courses.find((c) => c.id === e.courseId) }));
  }

  async createModule(offeringId: string, user: User, dto: ModuleDto) {
    this.assertCanManage(user, offeringId);
    const module: CourseModule = { id: randomUUID(), offeringId, ...dto };
    this.data.db.modules.push(module);
    await this.data.audit(user, 'CREATE_MODULE', 'CourseModule', module.id, module.title);
    return module;
  }

  async removeModule(id: string, user: User) {
    const index = this.data.db.modules.findIndex((m) => m.id === id);
    if (index < 0) throw new NotFoundException('Module not found');
    const module = this.data.db.modules[index];
    this.assertCanManage(user, module.offeringId);
    this.data.db.modules.splice(index, 1);
    this.data.db.materials = this.data.db.materials.filter((m) => m.moduleId !== id);
    await this.data.audit(user, 'DELETE_MODULE', 'CourseModule', id, module.title);
    return { success: true };
  }

  async createMaterial(moduleId: string, user: User, dto: MaterialDto) {
    const module = this.data.db.modules.find((m) => m.id === moduleId);
    if (!module) throw new NotFoundException('Module not found');
    this.assertCanManage(user, module.offeringId);
    const material: Material = { id: randomUUID(), moduleId, offeringId: module.offeringId, ...dto, status: dto.status ?? 'draft', createdAt: new Date().toISOString() };
    this.data.db.materials.push(material);
    await this.data.audit(user, 'CREATE_MATERIAL', 'Material', material.id, material.title);
    return material;
  }

  async updateMaterial(id: string, user: User, dto: MaterialDto) {
    const index = this.data.db.materials.findIndex((m) => m.id === id);
    if (index < 0) throw new NotFoundException('Material not found');
    this.assertCanManage(user, this.data.db.materials[index].offeringId);
    this.data.db.materials[index] = { ...this.data.db.materials[index], ...dto, updatedAt: new Date().toISOString() };
    await this.data.audit(user, 'UPDATE_MATERIAL', 'Material', id, dto.title);
    return this.data.db.materials[index];
  }

  async toggleMaterial(id: string, user: User) {
    const material = this.data.db.materials.find((m) => m.id === id);
    if (!material) throw new NotFoundException('Material not found');
    this.assertCanManage(user, material.offeringId);
    material.status = material.status === 'draft' ? 'published' : 'draft';
    material.updatedAt = new Date().toISOString();
    await this.data.save();
    return material;
  }

  async removeMaterial(id: string, user: User) {
    const index = this.data.db.materials.findIndex((m) => m.id === id);
    if (index < 0) throw new NotFoundException('Material not found');
    const material = this.data.db.materials[index];
    this.assertCanManage(user, material.offeringId);
    this.data.db.materials.splice(index, 1);
    await this.data.audit(user, 'DELETE_MATERIAL', 'Material', id, material.title);
    return { success: true };
  }

  private canManageOffering(user: User, offeringId: string) {
    if (['admin', 'hod'].includes(user.role)) return true;
    return user.role === 'lecturer' && !!this.data.db.offerings.find((o) => o.id === offeringId)?.lecturerIds.includes(user.id);
  }
  private assertCanManage(user: User, offeringId: string) {
    if (!this.canManageOffering(user, offeringId)) throw new ForbiddenException('You are not assigned to manage this course offering');
  }
}
