import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { DataService } from '../data/data.service';
import { Enrollment, RoleAssignment, User, toSafeUser } from '../data/entities';
import { DepartmentDto, EnrollmentDto, RoleAssignmentDto, SettingsDto, StudentDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(private data: DataService) {}
  stats(user: User) {
    const scopedUsers = this.data.db.users.filter((u) => u.matricNo && (user.role !== 'hod' || u.department === user.department));
    const active = scopedUsers.filter((u) => u.status === 'active').length;
    return {
      totalStudents: scopedUsers.length, activatedStudents: active,
      activatedPercentage: scopedUsers.length ? Math.round(active / scopedUsers.length * 100) : 0,
      totalLecturers: this.data.db.users.filter((u) => u.role === 'lecturer').length,
      coursesThisSession: this.data.db.offerings.filter((o) => o.session === this.data.db.settings.session).length,
      assignmentsCreated: this.data.db.assignments.length,
      pastPapersPendingReview: this.data.db.pastQuestions.filter((p) => p.status === 'pending').length,
      recentAuditLogs: this.data.db.auditLogs.slice(0, 10),
    };
  }
  roster(user: User, query: Record<string, string>) {
    const page = Math.max(Number(query.page) || 1, 1), limit = Math.min(Number(query.limit) || 20, 100);
    let items = this.data.db.users.filter((u) => !!u.matricNo && (user.role !== 'hod' || u.department === user.department));
    if (query.department && query.department !== 'all') items = items.filter((u) => u.department === query.department);
    if (query.level && query.level !== 'all') items = items.filter((u) => u.level === query.level);
    if (query.status && query.status !== 'all') items = items.filter((u) => u.status === query.status);
    if (query.search) items = items.filter((u) => `${u.name} ${u.matricNo}`.toLowerCase().includes(query.search.toLowerCase()));
    const mapped = items.map((u) => ({ matricNo: u.matricNo, fullName: u.name, department: u.department, level: u.level, status: u.status, email: u.email, id: u.id }));
    return { items: mapped.slice((page - 1) * limit, page * limit), total: mapped.length, page, totalPages: Math.ceil(mapped.length / limit) };
  }
  async upsertStudent(actor: User, dto: StudentDto) {
    if (actor.role === 'hod' && actor.department !== dto.department) throw new ForbiddenException('HOD can only manage their department');
    let user = this.data.db.users.find((u) => u.matricNo?.toLowerCase() === dto.matricNo.toLowerCase());
    if (user) Object.assign(user, { name: dto.fullName, department: dto.department, level: dto.level, email: dto.email ?? user.email, status: dto.status ?? user.status });
    else {
      user = { id: randomUUID(), name: dto.fullName, email: dto.email ?? `${dto.matricNo.replaceAll('/', '').toLowerCase()}@student.foc.edu.ng`, passwordHash: await hash(randomUUID(), 10), role: 'student', department: dto.department, level: dto.level, matricNo: dto.matricNo.toUpperCase(), avatar: '', status: dto.status ?? 'invited' };
      this.data.db.users.push(user);
    }
    await this.data.audit(actor, 'UPSERT_STUDENT', 'User', user.id, `${user.name} (${user.matricNo})`);
    return toSafeUser(user);
  }
  async status(actor: User, id: string, status: User['status'], reason?: string) {
    const user = this.data.db.users.find((u) => u.id === id && u.matricNo);
    if (!user) throw new NotFoundException('Student not found');
    if (actor.role === 'hod' && actor.department !== user.department) throw new ForbiddenException('HOD can only manage their department');
    user.status = status;
    await this.data.audit(actor, 'UPDATE_STUDENT_STATUS', 'User', id, user.name, reason);
    return toSafeUser(user);
  }
  roles() {
    const now = Date.now();
    this.data.db.roleAssignments.forEach((r) => { if (new Date(r.validTo).getTime() < now) r.isActive = false; });
    return this.data.db.roleAssignments;
  }
  async assignRole(actor: User, dto: RoleAssignmentDto) {
    const target = this.data.db.users.find((u) => u.id === dto.userId);
    if (!target) throw new NotFoundException('User not found');
    if (dto.role === 'admin' && actor.role !== 'admin') throw new ForbiddenException('Only admins can grant the admin role');
    if (actor.role === 'hod' && dto.scopeId !== actor.department) throw new ForbiddenException('HOD scope is limited to their department');
    const assignment: RoleAssignment = { id: randomUUID(), ...dto, userName: target.name, isActive: true, createdAt: new Date().toISOString() };
    this.data.db.roleAssignments.unshift(assignment);
    target.role = dto.role;
    if (dto.role === 'course_rep') target.repTermEndDate = dto.validTo;
    await this.data.audit(actor, 'ASSIGN_ROLE', 'RoleAssignment', assignment.id, `${dto.role}: ${target.name}`);
    return assignment;
  }
  async endRole(actor: User, id: string) {
    const role = this.data.db.roleAssignments.find((r) => r.id === id);
    if (!role) throw new NotFoundException('Role assignment not found');
    if (role.role === 'admin' && this.data.db.roleAssignments.filter((r) => r.role === 'admin' && r.isActive).length <= 1) throw new BadRequestException('Last Admin Protection: another active admin is required');
    role.isActive = false; role.validTo = new Date().toISOString().slice(0, 10);
    const target = this.data.db.users.find((u) => u.id === role.userId);
    if (target && target.role === role.role) target.role = 'student';
    await this.data.audit(actor, 'END_ROLE_TERM', 'RoleAssignment', id, role.userName);
    return role;
  }
  audits(query: Record<string, string>) {
    return this.data.db.auditLogs.filter((log) => (!query.role || query.role === 'all' || log.actorRole === query.role) && (!query.search || `${log.actorName} ${log.action} ${log.targetName}`.toLowerCase().includes(query.search.toLowerCase())));
  }
  offeringEnrollments(id: string) { return this.data.db.enrollments.filter((e) => e.offeringId === id).map((e) => ({ ...e, user: this.data.db.users.find((u) => u.id === e.userId) && toSafeUser(this.data.db.users.find((u) => u.id === e.userId)!) })); }
  async enroll(actor: User, offeringId: string, dto: EnrollmentDto) {
    const offering = this.data.db.offerings.find((o) => o.id === offeringId), user = this.data.db.users.find((u) => u.id === dto.userId);
    if (!offering || !user) throw new NotFoundException('Offering or student not found');
    if (this.data.db.enrollments.some((e) => e.offeringId === offeringId && e.userId === dto.userId)) throw new BadRequestException('Student is already enrolled');
    const enrollment: Enrollment = { id: randomUUID(), userId: dto.userId, offeringId, courseId: offering.courseId, courseCode: offering.courseCode, type: dto.type, session: offering.session };
    this.data.db.enrollments.push(enrollment); await this.data.audit(actor, 'ENROLL_STUDENT', 'Enrollment', enrollment.id, `${user.name}: ${offering.courseCode}`); return enrollment;
  }
  settings() { return this.data.db.settings; }
  async updateSettings(actor: User, dto: SettingsDto) { this.data.db.settings = dto; await this.data.audit(actor, 'UPDATE_SESSION_SETTINGS', 'Settings', 'academic', `${dto.session} ${dto.semester}`); return dto; }
  departments() { return this.data.db.departments; }
  async upsertDepartment(actor: User, dto: DepartmentDto) {
    let department = dto.id && this.data.db.departments.find((d) => d.id === dto.id);
    if (department) Object.assign(department, dto); else { department = { id: randomUUID(), name: dto.name, code: dto.code.toUpperCase(), isActive: dto.isActive ?? true }; this.data.db.departments.push(department); }
    await this.data.audit(actor, 'UPSERT_DEPARTMENT', 'Department', department.id, department.name); return department;
  }
}
