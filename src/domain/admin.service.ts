import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { User, toSafeUser } from '../data/entities';
import { PrismaService } from '../database/prisma.service';
import { DepartmentDto, EnrollmentDto, RoleAssignmentDto, SettingsDto, StudentDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async stats(user: User) {
    const studentWhere = { matricNo: { not: null }, ...(user.role === 'hod' ? { department: user.department } : {}) };
    const settings = await this.prisma.academicSettings.findUnique({ where: { id: 'default' } });
    const [totalStudents, activatedStudents, totalLecturers, coursesThisSession, assignmentsCreated, pastPapersPendingReview, recentAuditLogs] = await this.prisma.$transaction([
      this.prisma.user.count({ where: studentWhere }),
      this.prisma.user.count({ where: { ...studentWhere, status: 'active' } }),
      this.prisma.user.count({ where: { role: 'lecturer' } }),
      this.prisma.offering.count({ where: settings ? { session: settings.session } : {} }),
      this.prisma.assignment.count(),
      this.prisma.pastQuestion.count({ where: { status: 'pending', ...(user.role === 'hod' ? { department: user.department } : {}) } }),
      this.prisma.auditEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    return { totalStudents, activatedStudents, activatedPercentage: totalStudents ? Math.round(activatedStudents / totalStudents * 100) : 0, totalLecturers, coursesThisSession, assignmentsCreated, pastPapersPendingReview, recentAuditLogs };
  }

  async roster(user: User, query: Record<string, string>) {
    const page = Math.max(Number(query.page) || 1, 1), limit = Math.min(Number(query.limit) || 20, 100);
    const where = {
      matricNo: { not: null },
      ...(user.role === 'hod' ? { department: user.department } : {}),
      ...(query.department && query.department !== 'all' ? { department: query.department } : {}),
      ...(query.level && query.level !== 'all' ? { level: query.level } : {}),
      ...(query.status && query.status !== 'all' ? { status: query.status } : {}),
      ...(query.search ? { OR: [
        { name: { contains: query.search, mode: 'insensitive' as const } },
        { matricNo: { contains: query.search, mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.user.count({ where }),
    ]);
    return { items: items.map((item) => ({ matricNo: item.matricNo, fullName: item.name, department: item.department, level: item.level, status: item.status, email: item.email, id: item.id })), total, page, totalPages: Math.ceil(total / limit) };
  }

  async upsertStudent(actor: User, dto: StudentDto) {
    if (actor.role === 'hod' && actor.department !== dto.department) throw new ForbiddenException('HOD can only manage their department');
    const existing = await this.prisma.user.findFirst({ where: { matricNo: { equals: dto.matricNo, mode: 'insensitive' } } });
    const user = existing
      ? await this.prisma.user.update({ where: { id: existing.id }, data: { name: dto.fullName, department: dto.department, level: dto.level, ...(dto.email ? { email: dto.email } : {}), ...(dto.status ? { status: dto.status } : {}) } })
      : await this.prisma.user.create({ data: { name: dto.fullName, email: dto.email ?? `${dto.matricNo.replaceAll('/', '').toLowerCase()}@student.foc.edu.ng`, passwordHash: await hash(randomUUID(), 12), role: 'student', department: dto.department, level: dto.level, matricNo: dto.matricNo.toUpperCase(), status: dto.status ?? 'invited' } });
    await this.prisma.audit(actor, 'UPSERT_STUDENT', 'User', user.id, `${user.name} (${user.matricNo})`);
    return toSafeUser(user as unknown as User);
  }

  async status(actor: User, id: string, status: User['status'], reason?: string) {
    const user = await this.prisma.user.findFirst({ where: { id, matricNo: { not: null } } });
    if (!user) throw new NotFoundException('Student not found');
    if (actor.role === 'hod' && actor.department !== user.department) throw new ForbiddenException('HOD can only manage their department');
    const updated = await this.prisma.user.update({ where: { id }, data: { status } });
    await this.prisma.audit(actor, 'UPDATE_STUDENT_STATUS', 'User', id, user.name, reason);
    return toSafeUser(updated as unknown as User);
  }

  async roles() {
    await this.prisma.roleAssignment.updateMany({ where: { isActive: true, validTo: { lt: new Date() } }, data: { isActive: false } });
    return this.prisma.roleAssignment.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async assignRole(actor: User, dto: RoleAssignmentDto) {
    const target = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!target) throw new NotFoundException('User not found');
    if (dto.role === 'admin' && actor.role !== 'admin') throw new ForbiddenException('Only admins can grant the admin role');
    if (actor.role === 'hod' && dto.scopeId !== actor.department) throw new ForbiddenException('HOD scope is limited to their department');
    const assignment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.roleAssignment.create({ data: { ...dto, userName: target.name, validFrom: new Date(dto.validFrom), validTo: new Date(dto.validTo) } });
      await tx.user.update({ where: { id: target.id }, data: { role: dto.role, ...(dto.role === 'course_rep' ? { repTermEndDate: new Date(dto.validTo) } : {}) } });
      return created;
    });
    await this.prisma.audit(actor, 'ASSIGN_ROLE', 'RoleAssignment', assignment.id, `${dto.role}: ${target.name}`);
    return assignment;
  }

  async endRole(actor: User, id: string) {
    const role = await this.prisma.roleAssignment.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role assignment not found');
    if (role.role === 'admin' && await this.prisma.roleAssignment.count({ where: { role: 'admin', isActive: true } }) <= 1) throw new BadRequestException('Last Admin Protection: another active admin is required');
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.roleAssignment.update({ where: { id }, data: { isActive: false, validTo: new Date() } });
      const target = await tx.user.findUnique({ where: { id: role.userId } });
      if (target?.role === role.role) await tx.user.update({ where: { id: target.id }, data: { role: 'student', repTermEndDate: null } });
      return result;
    });
    await this.prisma.audit(actor, 'END_ROLE_TERM', 'RoleAssignment', id, role.userName);
    return updated;
  }

  audits(query: Record<string, string>) {
    return this.prisma.auditEntry.findMany({ where: {
      ...(query.role && query.role !== 'all' ? { actorRole: query.role } : {}),
      ...(query.search ? { OR: [
        { actorName: { contains: query.search, mode: 'insensitive' } },
        { action: { contains: query.search, mode: 'insensitive' } },
        { targetName: { contains: query.search, mode: 'insensitive' } },
      ] } : {}),
    }, orderBy: { createdAt: 'desc' }, take: 500 });
  }

  offeringEnrollments(id: string) {
    return this.prisma.enrollment.findMany({ where: { offeringId: id }, include: { user: { omit: { passwordHash: true, refreshTokenHash: true } } }, orderBy: { createdAt: 'desc' } });
  }

  async enroll(actor: User, offeringId: string, dto: EnrollmentDto) {
    const [offering, student] = await Promise.all([
      this.prisma.offering.findUnique({ where: { id: offeringId } }),
      this.prisma.user.findUnique({ where: { id: dto.userId } }),
    ]);
    if (!offering || !student) throw new NotFoundException('Offering or student not found');
    try {
      const enrollment = await this.prisma.enrollment.create({ data: { userId: dto.userId, offeringId, courseId: offering.courseId, courseCode: offering.courseCode, type: dto.type, session: offering.session } });
      await this.prisma.audit(actor, 'ENROLL_STUDENT', 'Enrollment', enrollment.id, `${student.name}: ${offering.courseCode}`);
      return enrollment;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'P2002') throw new BadRequestException('Student is already enrolled');
      throw error;
    }
  }

  async settings() {
    return this.prisma.academicSettings.findUnique({ where: { id: 'default' } });
  }

  async updateSettings(actor: User, dto: SettingsDto) {
    const settings = await this.prisma.academicSettings.upsert({ where: { id: 'default' }, update: dto, create: { id: 'default', ...dto } });
    await this.prisma.audit(actor, 'UPDATE_SESSION_SETTINGS', 'Settings', 'academic', `${dto.session} ${dto.semester}`);
    return settings;
  }

  departments() { return this.prisma.department.findMany({ orderBy: { name: 'asc' } }); }

  async upsertDepartment(actor: User, dto: DepartmentDto) {
    const existing = dto.id ? await this.prisma.department.findUnique({ where: { id: dto.id } }) : await this.prisma.department.findUnique({ where: { code: dto.code.toUpperCase() } });
    const department = existing
      ? await this.prisma.department.update({ where: { id: existing.id }, data: { name: dto.name, code: dto.code.toUpperCase(), ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }) } })
      : await this.prisma.department.create({ data: { name: dto.name, code: dto.code.toUpperCase(), isActive: dto.isActive ?? true } });
    await this.prisma.audit(actor, 'UPSERT_DEPARTMENT', 'Department', department.id, department.name);
    return department;
  }
}
