import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { toSafeUser } from '../common/user.util';
import { Role, UserStatus, Semester, RoleScopeType, EnrollmentType, Prisma } from '@prisma/client';
import {
  BulkStudentImportDto,
  DepartmentDto,
  EnrollmentDto,
  RoleAssignmentDto,
  SettingsDto,
  StudentDto,
} from './admin.dto';
import { parsePaginationParams } from '../common/pagination.util';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async stats(actor: { id: string; role: Role; departmentId?: string | null }) {
    const departmentFilter =
      actor.role === Role.hod && actor.departmentId
        ? { departmentId: actor.departmentId }
        : {};

    const [
      totalStudents,
      activatedStudents,
      totalLecturers,
      setting,
      assignmentsCreated,
      pastPapersPendingReview,
      recentAuditLogs,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { matricNo: { not: null }, ...departmentFilter },
      }),
      this.prisma.user.count({
        where: {
          matricNo: { not: null },
          status: UserStatus.active,
          ...departmentFilter,
        },
      }),
      this.prisma.user.count({ where: { role: Role.lecturer } }),
      this.prisma.setting.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.prisma.assignment.count(),
      this.prisma.pastQuestion.count({
        where: { status: 'pending', deletedAt: null },
      }),
      this.prisma.auditLog.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const coursesThisSession = setting
      ? await this.prisma.offering.count({ where: { session: setting.session } })
      : 0;

    const activatedPercentage =
      totalStudents > 0 ? Math.round((activatedStudents / totalStudents) * 100) : 0;

    return {
      totalStudents,
      activatedStudents,
      activatedPercentage,
      totalLecturers,
      coursesThisSession,
      assignmentsCreated,
      pastPapersPendingReview,
      recentAuditLogs,
    };
  }

  async roster(
    actor: { id: string; role: Role; departmentId?: string | null },
    query: Record<string, string>,
  ) {
    const { limit, page, cursor } = parsePaginationParams(query);

    const where: Prisma.UserWhereInput = {
      matricNo: { not: null },
    };

    if (actor.role === Role.hod && actor.departmentId) {
      where.departmentId = actor.departmentId;
    } else if (query.department && query.department !== 'all') {
      where.department = {
        OR: [{ name: query.department }, { code: query.department }],
      };
    }

    if (query.level && query.level !== 'all') {
      where.level = Number(query.level) || undefined;
    }

    if (query.status && query.status !== 'all') {
      where.status = query.status as UserStatus;
    }

    if (query.search) {
      const search = query.search.trim();
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { matricNo: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const total = await this.prisma.user.count({ where });

    let findArgs: Prisma.UserFindManyArgs = {
      where,
      include: { department: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
    };

    if (cursor) {
      findArgs = {
        ...findArgs,
        cursor: { id: cursor },
        skip: 1,
      };
    } else {
      findArgs = {
        ...findArgs,
        skip: (page - 1) * limit,
        take: limit + 1,
      };
    }

    const users = await this.prisma.user.findMany(findArgs);
    let nextCursor: string | undefined = undefined;
    if (users.length > limit) {
      const nextItem = users.pop();
      nextCursor = nextItem?.id;
    }

    const mapped = users.map((u) => ({
      id: u.id,
      matricNo: u.matricNo,
      fullName: u.fullName,
      department: (u as any).department?.name || null,
      level: u.level ? String(u.level) : null,
      status: u.status,
      email: u.email,
    }));

    return {
      items: mapped,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      nextCursor,
    };
  }

  async upsertStudent(
    actor: { id: string; fullName: string; role: Role; departmentId?: string | null },
    dto: StudentDto,
  ) {
    const dept = await this.prisma.department.findFirst({
      where: {
        OR: [{ name: dto.department }, { code: dto.department }],
      },
    });

    if (actor.role === Role.hod && actor.departmentId && dept?.id !== actor.departmentId) {
      throw new ForbiddenException('HOD can only manage their department');
    }

    const normalizedMatric = dto.matricNo.trim().toUpperCase();
    const existing = await this.prisma.user.findUnique({
      where: { matricNo: normalizedMatric },
      include: { department: true },
    });

    if (
      existing &&
      actor.role === Role.hod &&
      actor.departmentId &&
      existing.departmentId &&
      existing.departmentId !== actor.departmentId
    ) {
      throw new ForbiddenException(
        'HOD cannot modify a student belonging to another department',
      );
    }

    let student: any;
    if (existing) {
      student = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          fullName: dto.fullName,
          departmentId: dept?.id,
          level: Number(dto.level) || 100,
          email: dto.email ? dto.email.trim().toLowerCase() : existing.email,
          status: (dto.status as UserStatus) || existing.status,
        },
        include: { department: true },
      });
    } else {
      student = await this.prisma.user.create({
        data: {
          fullName: dto.fullName,
          matricNo: normalizedMatric,
          email: dto.email
            ? dto.email.trim().toLowerCase()
            : `${normalizedMatric.replaceAll('/', '').toLowerCase()}@student.foc.edu.ng`,
          passwordHash: await hash(randomUUID(), 10),
          role: Role.student,
          departmentId: dept?.id,
          level: Number(dto.level) || 100,
          status: (dto.status as UserStatus) || UserStatus.invited,
        },
        include: { department: true },
      });
    }

    await this.audit.log(
      actor,
      'UPSERT_STUDENT',
      'User',
      student.id,
      `${student.fullName} (${student.matricNo})`,
    );

    return toSafeUser(student);
  }

  async bulkUpsertStudents(
    actor: { id: string; fullName: string; role: Role; departmentId?: string | null },
    dto: BulkStudentImportDto,
  ) {
    if (!dto.students || dto.students.length === 0) {
      throw new BadRequestException('At least one student record is required for bulk import');
    }

    if (dto.students.length > 500) {
      throw new BadRequestException('Bulk import batch size cannot exceed 500 students per request');
    }

    const departments = await this.prisma.department.findMany();
    const deptMap = new Map<string, any>();
    for (const d of departments) {
      deptMap.set(d.name.toLowerCase(), d);
      deptMap.set(d.code.toLowerCase(), d);
      deptMap.set(d.id, d);
    }

    const created: any[] = [];
    const updated: any[] = [];
    const rejected: Array<{ matricNo: string; row: number; reason: string }> = [];
    let skipped = 0;

    const seenMatricsInBatch = new Set<string>();
    const validRows: Array<{
      rowNumber: number;
      matricNo: string;
      fullName: string;
      deptId: string;
      level: number;
      email?: string;
      status: UserStatus;
    }> = [];

    for (let i = 0; i < dto.students.length; i++) {
      const row = dto.students[i];
      const rowNumber = i + 1;
      const normalizedMatric = row.matricNo?.trim().toUpperCase();

      if (!normalizedMatric) {
        rejected.push({ matricNo: '', row: rowNumber, reason: 'Matric number is required' });
        continue;
      }

      if (seenMatricsInBatch.has(normalizedMatric)) {
        if (dto.skipDuplicates) {
          skipped++;
          continue;
        } else {
          rejected.push({
            matricNo: normalizedMatric,
            row: rowNumber,
            reason: 'Duplicate matric number in import payload',
          });
          continue;
        }
      }
      seenMatricsInBatch.add(normalizedMatric);

      const dept = deptMap.get(row.department?.trim().toLowerCase());
      if (!dept) {
        rejected.push({
          matricNo: normalizedMatric,
          row: rowNumber,
          reason: `Department '${row.department}' not recognized`,
        });
        continue;
      }

      if (actor.role === Role.hod && actor.departmentId && dept.id !== actor.departmentId) {
        rejected.push({
          matricNo: normalizedMatric,
          row: rowNumber,
          reason: 'HOD cannot import students outside their assigned department',
        });
        continue;
      }

      const levelNum = row.level === 'PG' ? 800 : Number(row.level) || 100;
      const status = (row.status as UserStatus) || UserStatus.invited;

      validRows.push({
        rowNumber,
        matricNo: normalizedMatric,
        fullName: row.fullName.trim(),
        deptId: dept.id,
        level: levelNum,
        email: row.email?.trim().toLowerCase(),
        status,
      });
    }

    const validMatrics = validRows.map((r) => r.matricNo);
    const existingUsers = await this.prisma.user.findMany({
      where: { matricNo: { in: validMatrics } },
      include: { department: true },
    });
    const existingMap = new Map(existingUsers.map((u) => [u.matricNo!, u]));

    await this.prisma.$transaction(async (tx) => {
      for (const row of validRows) {
        const existing = existingMap.get(row.matricNo);

        if (existing) {
          if (
            actor.role === Role.hod &&
            actor.departmentId &&
            existing.departmentId &&
            existing.departmentId !== actor.departmentId
          ) {
            rejected.push({
              matricNo: row.matricNo,
              row: row.rowNumber,
              reason: 'Existing student belongs to another department; HOD cannot modify them',
            });
            continue;
          }

          if (dto.skipDuplicates && existing.status === UserStatus.active) {
            skipped++;
            continue;
          }

          const updatedUser = await tx.user.update({
            where: { id: existing.id },
            data: {
              fullName: row.fullName,
              departmentId: row.deptId,
              level: row.level,
              email: row.email || existing.email,
              status: row.status || existing.status,
            },
            include: { department: true },
          });

          updated.push(toSafeUser(updatedUser));
        } else {
          const defaultEmail = `${row.matricNo.replaceAll('/', '').toLowerCase()}@student.foc.edu.ng`;
          const createdUser = await tx.user.create({
            data: {
              fullName: row.fullName,
              matricNo: row.matricNo,
              email: row.email || defaultEmail,
              passwordHash: await hash(randomUUID(), 10),
              role: Role.student,
              departmentId: row.deptId,
              level: row.level,
              status: row.status,
            },
            include: { department: true },
          });

          created.push(toSafeUser(createdUser));
        }
      }

      await this.audit.log(
        actor,
        'BULK_IMPORT_STUDENTS',
        'User',
        'bulk',
        `Bulk import: ${created.length} created, ${updated.length} updated, ${skipped} skipped, ${rejected.length} rejected`,
        undefined,
        {
          total: dto.students.length,
          created: created.length,
          updated: updated.length,
          skipped,
          rejectedCount: rejected.length,
        },
        tx,
      );
    });

    return {
      success: true,
      total: dto.students.length,
      created: created.length,
      updated: updated.length,
      skipped,
      rejected,
      items: [...created, ...updated],
    };
  }

  async status(
    actor: { id: string; fullName: string; role: Role; departmentId?: string | null },
    id: string,
    status: UserStatus,
    reason?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { department: true },
    });

    if (!user || !user.matricNo) {
      throw new NotFoundException('Student not found');
    }

    if (actor.role === Role.hod && actor.departmentId && user.departmentId !== actor.departmentId) {
      throw new ForbiddenException('HOD can only manage their department');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status },
      include: { department: true },
    });

    await this.audit.log(actor, 'UPDATE_STUDENT_STATUS', 'User', id, user.fullName, reason);
    return toSafeUser(updated);
  }

  async roles() {
    const now = new Date();
    await this.prisma.roleAssignment.updateMany({
      where: { validTo: { lt: now }, isActive: true },
      data: { isActive: false },
    });

    const list = await this.prisma.roleAssignment.findMany({
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });

    return list.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.user.fullName,
      role: r.role,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      validFrom: r.validFrom.toISOString().slice(0, 10),
      validTo: r.validTo.toISOString().slice(0, 10),
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async assignRole(
    actor: { id: string; fullName: string; role: Role; departmentId?: string | null },
    dto: RoleAssignmentDto,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      include: { department: true },
    });

    if (!target) throw new NotFoundException('User not found');
    if (dto.role === 'admin' && actor.role !== Role.admin) {
      throw new ForbiddenException('Only admins can grant the admin role');
    }
    if (actor.role === Role.hod) {
      if (dto.role === 'admin' || dto.role === 'hod') {
        throw new ForbiddenException('HOD cannot grant administrative or HOD roles');
      }
      if (actor.departmentId && target.departmentId && target.departmentId !== actor.departmentId) {
        throw new ForbiddenException('HOD can only manage their department');
      }
      const dept = target.department;
      if (dto.scopeId !== dept?.name && dto.scopeId !== dept?.code && dto.scopeId !== actor.departmentId) {
        throw new ForbiddenException('HOD scope is limited to their department');
      }
    }

    const validFrom = new Date(dto.validFrom);
    const validTo = new Date(dto.validTo);

    const assignment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.roleAssignment.create({
        data: {
          userId: target.id,
          role: dto.role as Role,
          scopeType: dto.scopeType as RoleScopeType,
          scopeId: dto.scopeId,
          validFrom,
          validTo,
          createdBy: actor.id,
          isActive: true,
        },
      });

      await tx.user.update({
        where: { id: target.id },
        data: {
          role: dto.role as Role,
          repTermStart: dto.role === 'course_rep' ? validFrom : undefined,
          repTermEnd: dto.role === 'course_rep' ? validTo : undefined,
        },
      });

      await this.audit.log(
        actor,
        'ASSIGN_ROLE',
        'RoleAssignment',
        created.id,
        `${dto.role}: ${target.fullName}`,
        undefined,
        undefined,
        tx,
      );

      return created;
    });

    return {
      id: assignment.id,
      userId: assignment.userId,
      userName: target.fullName,
      role: assignment.role,
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId,
      validFrom: assignment.validFrom.toISOString().slice(0, 10),
      validTo: assignment.validTo.toISOString().slice(0, 10),
      isActive: assignment.isActive,
      createdAt: assignment.createdAt.toISOString(),
    };
  }

  async endRole(
    actor: { id: string; fullName: string; role: Role; departmentId?: string | null },
    id: string,
  ) {
    const role = await this.prisma.roleAssignment.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!role) throw new NotFoundException('Role assignment not found');

    if (actor.role === Role.hod) {
      if (role.role === Role.admin || role.role === Role.hod) {
        throw new ForbiddenException('HOD cannot end administrative or HOD roles');
      }
      if (actor.departmentId && role.user?.departmentId && role.user.departmentId !== actor.departmentId) {
        throw new ForbiddenException('HOD can only manage roles within their department');
      }
    }

    if (role.role === Role.admin) {
      const activeAdminCount = await this.prisma.roleAssignment.count({
        where: { role: Role.admin, isActive: true },
      });
      if (activeAdminCount <= 1) {
        throw new BadRequestException(
          'Last Admin Protection: another active admin is required',
        );
      }
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.update({
        where: { id },
        data: { isActive: false, validTo: now },
      });

      if (role.user.role === role.role) {
        // Query remaining active and valid role assignments for this user
        const remainingAssignments = await tx.roleAssignment.findMany({
          where: {
            userId: role.userId,
            isActive: true,
            id: { not: id },
            validTo: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
        });

        // Determine effective role following hierarchy: admin > hod > lecturer > course_rep > user.baseRole
        const activeRoles = remainingAssignments.map((a) => a.role);
        let baseRole: Role = (role.user as any).baseRole;
        // Follow-up Check 1: Existing users' baseRole values must preserve their actual underlying roles.
        // If baseRole is student (default) or absent, but the user is actually a staff member (has staffId or role is lecturer/hod/admin),
        // safely preserve their actual staff role and prevent unintended demotion to student.
        if (!baseRole || baseRole === Role.student) {
          if (role.user.staffId || role.user.role === Role.lecturer || role.user.role === Role.hod) {
            baseRole = Role.lecturer;
          } else if (role.user.role === Role.admin) {
            baseRole = Role.admin;
          } else {
            baseRole = Role.student;
          }
        }
        let nextRole: Role = baseRole;

        if (activeRoles.includes(Role.admin)) {
          nextRole = Role.admin;
        } else if (activeRoles.includes(Role.hod)) {
          nextRole = Role.hod;
        } else if (activeRoles.includes(Role.lecturer)) {
          nextRole = Role.lecturer;
        } else if (activeRoles.includes(Role.course_rep)) {
          nextRole = Role.course_rep;
        }

        const repTermUpdate =
          nextRole === Role.course_rep
            ? {}
            : { repTermEnd: null, repTermStart: null };

        await tx.user.update({
          where: { id: role.userId },
          data: {
            role: nextRole,
            ...repTermUpdate,
          },
        });
      }

      await this.audit.log(
        actor,
        'END_ROLE_TERM',
        'RoleAssignment',
        id,
        role.user.fullName,
        undefined,
        undefined,
        tx,
      );
    });

    return {
      id: role.id,
      userId: role.userId,
      userName: role.user.fullName,
      role: role.role,
      isActive: false,
      validTo: now.toISOString().slice(0, 10),
    };
  }

  async audits(query: Record<string, string>) {
    const { limit, cursor } = parsePaginationParams(query);

    const where: Prisma.AuditLogWhereInput = {};
    if (query.role && query.role !== 'all') {
      where.actorRole = query.role;
    }
    if (query.search) {
      const search = query.search.trim();
      where.OR = [
        { actorName: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
        { targetName: { contains: search, mode: 'insensitive' } },
      ];
    }

    let findArgs: Prisma.AuditLogFindManyArgs = {
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    };

    if (cursor) {
      findArgs = {
        ...findArgs,
        cursor: { id: cursor },
        skip: 1,
      };
    }

    const logs = await this.prisma.auditLog.findMany(findArgs);
    let nextCursor: string | undefined = undefined;
    if (logs.length > limit) {
      const nextItem = logs.pop();
      nextCursor = nextItem?.id;
    }

    return {
      items: logs,
      nextCursor,
    };
  }

  async offeringEnrollments(
    actor: { id: string; role: Role; departmentId?: string | null },
    offeringId: string,
  ) {
    const offering = await this.prisma.offering.findUnique({
      where: { id: offeringId },
      include: { course: true },
    });
    if (!offering) throw new NotFoundException('Course offering not found');

    if (
      actor.role === Role.hod &&
      actor.departmentId &&
      offering.course.departmentId !== actor.departmentId
    ) {
      throw new ForbiddenException(
        'HOD can only view enrollments for courses in their department',
      );
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: { offeringId },
      include: {
        user: { include: { department: true } },
      },
    });

    return enrollments.map((e) => ({
      id: e.id,
      offeringId: e.offeringId,
      userId: e.userId,
      type: e.type,
      user: toSafeUser(e.user),
    }));
  }

  async enroll(
    actor: { id: string; fullName: string; role: Role; departmentId?: string | null },
    offeringId: string,
    dto: EnrollmentDto,
  ) {
    const [offering, user] = await Promise.all([
      this.prisma.offering.findUnique({
        where: { id: offeringId },
        include: { course: true },
      }),
      this.prisma.user.findUnique({ where: { id: dto.userId } }),
    ]);

    if (!offering || !user) {
      throw new NotFoundException('Offering or student not found');
    }

    if (
      actor.role === Role.hod &&
      actor.departmentId &&
      offering.course.departmentId !== actor.departmentId
    ) {
      throw new ForbiddenException(
        'HOD can only manage enrollments for courses in their department',
      );
    }

    const existing = await this.prisma.enrollment.findUnique({
      where: {
        offeringId_userId: { offeringId, userId: dto.userId },
      },
    });

    if (existing) {
      throw new BadRequestException('Student is already enrolled');
    }

    const enrollment = await this.prisma.enrollment.create({
      data: {
        offeringId,
        userId: dto.userId,
        type: (dto.type as EnrollmentType) || EnrollmentType.regular,
      },
    });

    await this.audit.log(
      actor,
      'ENROLL_STUDENT',
      'Enrollment',
      enrollment.id,
      `${user.fullName}: ${offering.course.code}`,
    );

    return enrollment;
  }

  async settings() {
    const setting = await this.prisma.setting.findFirst({
      orderBy: { updatedAt: 'desc' },
    });
    return setting || { session: '2026/2027', semester: 'first' };
  }

  async updateSettings(
    actor: { id: string; fullName: string; role: Role },
    dto: SettingsDto,
  ) {
    const existing = await this.prisma.setting.findFirst({
      orderBy: { updatedAt: 'desc' },
    });

    const semester =
      dto.semester?.toLowerCase().includes('second') ? Semester.second : Semester.first;

    let updated: any;
    if (existing) {
      updated = await this.prisma.setting.update({
        where: { id: existing.id },
        data: { session: dto.session, semester },
      });
    } else {
      updated = await this.prisma.setting.create({
        data: { session: dto.session, semester },
      });
    }

    await this.audit.log(
      actor,
      'UPDATE_SESSION_SETTINGS',
      'Settings',
      'academic',
      `${dto.session} ${dto.semester}`,
    );

    return updated;
  }

  async departments() {
    return this.prisma.department.findMany({
      orderBy: { code: 'asc' },
    });
  }

  async upsertDepartment(
    actor: { id: string; fullName: string; role: Role },
    dto: DepartmentDto,
  ) {
    const code = dto.code.trim().toUpperCase();
    const department = await this.prisma.department.upsert({
      where: { code },
      update: { name: dto.name },
      create: {
        code,
        name: dto.name,
      },
    });

    await this.audit.log(
      actor,
      'UPSERT_DEPARTMENT',
      'Department',
      department.id,
      department.name,
    );

    return department;
  }
}
