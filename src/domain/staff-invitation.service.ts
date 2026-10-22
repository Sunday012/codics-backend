import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash } from 'bcryptjs';
import { Prisma, Role, RoleScopeType } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { MailService, maskEmailAddress } from '../common/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AcceptStaffInvitationDto,
  CreateStaffInvitationDto,
  ListStaffInvitationsQueryDto,
} from './staff-invitation.dto';

export interface InviterActor {
  id: string;
  fullName: string;
  email?: string | null;
  role: Role;
  departmentId?: string | null;
}

@Injectable()
export class StaffInvitationService {
  private readonly logger = new Logger(StaffInvitationService.name);
  private readonly frontendUrl: string;
  private readonly invitationTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    this.frontendUrl =
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:5173';
  }

  /**
   * Generates a cryptographically secure token and its SHA-256 hash.
   * Only the hash is stored in the database.
   */
  private generateToken(): { rawToken: string; tokenHash: string } {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    return { rawToken, tokenHash };
  }

  /**
   * Hashes a raw token with SHA-256.
   */
  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken.trim()).digest('hex');
  }

  /**
   * Generates an institution-standard Staff ID if not provided.
   */
  private generateDefaultStaffId(role: Role, departmentCode?: string | null): string {
    const code = (departmentCode || 'FOC').toUpperCase().slice(0, 3);
    const roleLetter = role === Role.admin ? 'A' : role === Role.hod ? 'H' : 'L';
    const randDigits = Math.floor(100 + Math.random() * 900);
    return `${code}/${roleLetter}/${randDigits}`;
  }

  /**
   * Validates inviter authorization according to the staff authorization matrix.
   */
  private validateInviterPermissions(actor: InviterActor, targetRole: Role, targetDepartmentId: string): void {
    if (actor.role === Role.admin) {
      // System Admins can invite lecturers, HODs, and fellow admins across any department
      return;
    }

    if (actor.role === Role.hod) {
      // HODs can ONLY invite lecturers
      if (targetRole !== Role.lecturer) {
        throw new ForbiddenException('HODs are only authorized to invite lecturers');
      }

      // HODs can ONLY invite for their own department
      if (!actor.departmentId || actor.departmentId !== targetDepartmentId) {
        throw new ForbiddenException('HODs can only invite staff to their own department');
      }
      return;
    }

    // All other roles are strictly prohibited from issuing staff invitations
    throw new ForbiddenException('You are not authorized to issue staff invitations');
  }

  /**
   * Creates and dispatches a single-use staff invitation.
   * Stores ONLY the token hash in the database.
   * Returns the raw token and invitation URL ONCE in the response for copy-link fallback.
   */
  async createInvitation(actor: InviterActor, dto: CreateStaffInvitationDto) {
    const cleanEmail = dto.email.trim().toLowerCase();
    const departmentId = dto.departmentId.trim();

    // 1. Authorization & Scope validation
    this.validateInviterPermissions(actor, dto.role, departmentId);

    // 2. Department existence check
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
    });
    if (!department) {
      throw new NotFoundException('Department not found');
    }

    // 3. Prevent duplicate active staff accounts for the same email
    const existingStaff = await this.prisma.user.findFirst({
      where: {
        email: cleanEmail,
        role: dto.role,
        departmentId,
        status: 'active',
      },
    });
    if (existingStaff) {
      throw new BadRequestException(
        'An active staff member with this email already exists in this department with this role',
      );
    }

    // 4. Cryptographic token generation (256-bit entropy)
    const { rawToken, tokenHash } = this.generateToken();
    const expiresAt = new Date(Date.now() + this.invitationTtlMs);

    // 5. Database transaction: Revoke previous pending invitations for this email and record new one
    const invitation = await this.prisma.$transaction(async (tx) => {
      // Revoke any previous pending invitations for this email to prevent token concurrency
      await tx.staffInvitation.updateMany({
        where: {
          email: cleanEmail,
          status: 'pending',
        },
        data: {
          status: 'revoked',
        },
      });

      const created = await tx.staffInvitation.create({
        data: {
          email: cleanEmail,
          fullName: dto.fullName.trim(),
          role: dto.role,
          departmentId,
          tokenHash,
          invitedById: actor.id,
          status: 'pending',
          expiresAt,
        },
      });

      await this.audit.log(
        actor,
        'CREATE_STAFF_INVITATION',
        'StaffInvitation',
        created.id,
        cleanEmail,
        `Invited as ${dto.role} to ${department.name}`,
        undefined,
        tx,
      );

      return created;
    });

    // 6. Build invitation URL
    const invitationLink = `${this.frontendUrl}/accept-invitation?token=${encodeURIComponent(rawToken)}`;

    // 7. Transactional email delivery with graceful fallback
    let emailReceipt: any = { status: 'failed', provider: 'none' };
    try {
      emailReceipt = await this.mail.sendStaffInvitation(cleanEmail, invitationLink, {
        fullName: dto.fullName.trim(),
        role: dto.role,
        departmentName: department.name,
        inviterName: actor.fullName,
        expiresAt,
      });
    } catch (err: any) {
      this.logger.warn(
        `Staff invitation email delivery failed for ${maskEmailAddress(cleanEmail)}: ${err?.message}`,
      );
      emailReceipt = {
        status: 'failed',
        provider: 'mail_service',
        errorCode: err?.message || 'DELIVERY_ERROR',
      };
    }

    return {
      id: invitation.id,
      email: invitation.email,
      fullName: invitation.fullName,
      role: invitation.role,
      departmentId: invitation.departmentId,
      departmentName: department.name,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      // SECURITY: The raw token is returned ONLY in this response for copy-link fallback
      token: rawToken,
      invitationLink,
      emailDelivery: {
        status: emailReceipt.status,
        provider: emailReceipt.provider,
        maskedRecipient: maskEmailAddress(cleanEmail),
      },
      createdAt: invitation.createdAt,
    };
  }

  /**
   * Lists invitations within the inviter's authorized scope.
   * HODs see only their department. Admins can view all.
   * Never exposes tokenHash in responses.
   */
  async listInvitations(actor: InviterActor, query: ListStaffInvitationsQueryDto) {
    let effectiveDepartmentId: string | undefined = undefined;

    if (actor.role === Role.hod) {
      if (!actor.departmentId) {
        throw new ForbiddenException('HOD has no assigned department');
      }
      if (query.departmentId && query.departmentId !== actor.departmentId) {
        throw new ForbiddenException('HODs can only access invitations for their own department');
      }
      effectiveDepartmentId = actor.departmentId;
    } else if (actor.role === Role.admin) {
      effectiveDepartmentId = query.departmentId;
    } else {
      throw new ForbiddenException('You are not authorized to view staff invitations');
    }

    // Proactively mark expired invitations whose deadline has passed
    const now = new Date();
    await this.prisma.staffInvitation.updateMany({
      where: {
        status: 'pending',
        expiresAt: { lt: now },
      },
      data: {
        status: 'expired',
      },
    });

    const where: Prisma.StaffInvitationWhereInput = {
      ...(effectiveDepartmentId ? { departmentId: effectiveDepartmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { fullName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      this.prisma.staffInvitation.count({ where }),
      this.prisma.staffInvitation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          departmentId: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          createdAt: true,
          updatedAt: true,
          department: {
            select: { id: true, name: true, code: true },
          },
          invitedBy: {
            select: { id: true, fullName: true, email: true },
          },
          acceptedBy: {
            select: { id: true, fullName: true, email: true },
          },
          // SECURITY: tokenHash is excluded
        },
      }),
    ]);

    return {
      invitations: items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Revokes a pending staff invitation.
   */
  async revokeInvitation(actor: InviterActor, id: string) {
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { id },
      include: { department: true },
    });

    if (!invitation) {
      throw new NotFoundException('Staff invitation not found');
    }

    // Scope check: HODs can only revoke in their department
    if (actor.role === Role.hod && invitation.departmentId !== actor.departmentId) {
      throw new ForbiddenException('HODs can only manage invitations within their department');
    } else if (actor.role !== Role.admin && actor.role !== Role.hod) {
      throw new ForbiddenException('You are not authorized to revoke staff invitations');
    }

    if (invitation.status === 'accepted') {
      throw new BadRequestException('Cannot revoke an already accepted invitation');
    }

    if (invitation.status === 'revoked') {
      throw new BadRequestException('Invitation has already been revoked');
    }

    const updated = await this.prisma.staffInvitation.update({
      where: { id },
      data: { status: 'revoked' },
    });

    await this.audit.log(
      actor,
      'REVOKE_STAFF_INVITATION',
      'StaffInvitation',
      id,
      invitation.email,
      'Invitation manually revoked by inviter',
    );

    return {
      id: updated.id,
      status: updated.status,
      message: 'Staff invitation revoked successfully',
    };
  }

  /**
   * Resends an invitation with a fresh cryptographic token and renewed expiration.
   */
  async resendInvitation(actor: InviterActor, id: string) {
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { id },
      include: { department: true },
    });

    if (!invitation) {
      throw new NotFoundException('Staff invitation not found');
    }

    if (actor.role === Role.hod && invitation.departmentId !== actor.departmentId) {
      throw new ForbiddenException('HODs can only manage invitations within their department');
    } else if (actor.role !== Role.admin && actor.role !== Role.hod) {
      throw new ForbiddenException('You are not authorized to resend staff invitations');
    }

    if (invitation.status === 'accepted') {
      throw new BadRequestException('Cannot resend an already accepted invitation');
    }

    const { rawToken, tokenHash } = this.generateToken();
    const expiresAt = new Date(Date.now() + this.invitationTtlMs);

    const updated = await this.prisma.staffInvitation.update({
      where: { id },
      data: {
        tokenHash,
        expiresAt,
        status: 'pending',
        invitedById: actor.id,
      },
    });

    const invitationLink = `${this.frontendUrl}/accept-invitation?token=${encodeURIComponent(rawToken)}`;

    let emailReceipt: any = { status: 'failed', provider: 'none' };
    try {
      emailReceipt = await this.mail.sendStaffInvitation(updated.email, invitationLink, {
        fullName: updated.fullName,
        role: updated.role,
        departmentName: invitation.department.name,
        inviterName: actor.fullName,
        expiresAt,
      });
    } catch (err: any) {
      this.logger.warn(`Failed to resend invitation email to ${maskEmailAddress(updated.email)}`);
      emailReceipt = { status: 'failed', provider: 'mail_service', errorCode: err?.message };
    }

    await this.audit.log(
      actor,
      'RESEND_STAFF_INVITATION',
      'StaffInvitation',
      id,
      updated.email,
      'Invitation renewed with fresh token',
    );

    return {
      id: updated.id,
      email: updated.email,
      fullName: updated.fullName,
      role: updated.role,
      departmentId: updated.departmentId,
      departmentName: invitation.department.name,
      status: updated.status,
      expiresAt: updated.expiresAt,
      token: rawToken,
      invitationLink,
      emailDelivery: {
        status: emailReceipt.status,
        provider: emailReceipt.provider,
        maskedRecipient: maskEmailAddress(updated.email),
      },
    };
  }

  /**
   * Public endpoint to verify that a token is valid and pending.
   * Returns public metadata for frontend registration screen without exposing secrets.
   */
  async verifyInvitationToken(token: string) {
    if (!token || typeof token !== 'string' || token.trim().length < 16) {
      throw new BadRequestException('Invalid or missing invitation token');
    }

    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash },
      include: {
        department: { select: { id: true, name: true, code: true } },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invalid or unknown invitation token');
    }

    if (invitation.status === 'accepted') {
      throw new BadRequestException('This invitation has already been accepted');
    }

    if (invitation.status === 'revoked') {
      throw new BadRequestException('This invitation has been revoked');
    }

    if (invitation.status === 'expired' || invitation.expiresAt < new Date()) {
      if (invitation.status === 'pending') {
        await this.prisma.staffInvitation.update({
          where: { id: invitation.id },
          data: { status: 'expired' },
        });
      }
      throw new BadRequestException('This invitation has expired');
    }

    return {
      valid: true,
      email: invitation.email,
      fullName: invitation.fullName,
      role: invitation.role,
      departmentId: invitation.departmentId,
      departmentName: invitation.department.name,
      departmentCode: invitation.department.code,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Atomically accepts an invitation and completes staff onboarding.
   * Prevents replay and concurrent acceptance via atomic compare-and-swap (CAS).
   */
  async acceptInvitation(dto: AcceptStaffInvitationDto, req?: Request, res?: Response) {
    if (!dto.token || dto.token.trim().length < 16) {
      throw new BadRequestException('Invalid or missing invitation token');
    }

    if (!dto.password || dto.password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    if (dto.confirmPassword && dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const tokenHash = this.hashToken(dto.token);
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash },
      include: { department: true },
    });

    if (!invitation) {
      throw new NotFoundException('Invalid or unknown invitation token');
    }

    if (invitation.status === 'accepted') {
      throw new BadRequestException('This invitation has already been accepted');
    }

    if (invitation.status === 'revoked') {
      throw new BadRequestException('This invitation has been revoked');
    }

    const now = new Date();
    if (invitation.status === 'expired' || invitation.expiresAt < now) {
      if (invitation.status === 'pending') {
        await this.prisma.staffInvitation.update({
          where: { id: invitation.id },
          data: { status: 'expired' },
        });
      }
      throw new BadRequestException('This invitation has expired');
    }

    const passwordHash = await hash(dto.password, 12);
    const staffId =
      dto.staffId?.trim() ||
      this.generateDefaultStaffId(invitation.role, invitation.department.code);
    const fullName = dto.fullName?.trim() || invitation.fullName;

    // Phase 12.1 Follow-up Check 1: baseRole must preserve actual underlying role
    // For HOD, baseRole is lecturer (HOD is an academic staff appointment)
    // For admin, baseRole is admin
    // For lecturer, baseRole is lecturer
    const baseRole = invitation.role === Role.hod ? Role.lecturer : invitation.role;

    // ATOMIC TRANSACTION: CAS update to prevent concurrency/replay, then provision user & role
    const { user } = await this.prisma.$transaction(async (tx) => {
      // 1. Atomic Compare-And-Swap (CAS) consumption of invitation
      const casResult = await tx.staffInvitation.updateMany({
        where: {
          id: invitation.id,
          status: 'pending',
          expiresAt: { gt: now },
        },
        data: {
          status: 'accepted',
          acceptedAt: now,
        },
      });

      if (casResult.count === 0) {
        throw new ConflictException(
          'Invitation was already accepted or modified concurrently',
        );
      }

      // 2. Check if a user with this email already exists
      let targetUser = await tx.user.findUnique({
        where: { email: invitation.email },
        include: { department: true },
      });

      if (targetUser) {
        // Update existing user with new staff role, department, password, and active status
        targetUser = await tx.user.update({
          where: { id: targetUser.id },
          data: {
            fullName,
            passwordHash,
            role: invitation.role,
            baseRole,
            departmentId: invitation.departmentId,
            staffId: targetUser.staffId || staffId,
            status: 'active',
            activatedAt: targetUser.activatedAt || now,
          },
          include: { department: true },
        });
      } else {
        // Create new active staff user
        targetUser = await tx.user.create({
          data: {
            email: invitation.email,
            fullName,
            passwordHash,
            role: invitation.role,
            baseRole,
            departmentId: invitation.departmentId,
            staffId,
            status: 'active',
            activatedAt: now,
          },
          include: { department: true },
        });
      }

      // 3. Link acceptedById on StaffInvitation
      await tx.staffInvitation.update({
        where: { id: invitation.id },
        data: { acceptedById: targetUser.id },
      });

      // 4. Create an official RoleAssignment record for HOD or Admin roles
      if (invitation.role === Role.hod) {
        await tx.roleAssignment.create({
          data: {
            userId: targetUser.id,
            role: Role.hod,
            scopeType: RoleScopeType.department,
            scopeId: invitation.departmentId,
            validFrom: now,
            validTo: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000), // 1 year appointment
            createdBy: invitation.invitedById,
            isActive: true,
          },
        });
      } else if (invitation.role === Role.admin) {
        await tx.roleAssignment.create({
          data: {
            userId: targetUser.id,
            role: Role.admin,
            scopeType: RoleScopeType.faculty,
            scopeId: 'faculty',
            validFrom: now,
            validTo: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            createdBy: invitation.invitedById,
            isActive: true,
          },
        });
      }

      // 5. Audit log
      await this.audit.log(
        targetUser,
        'ACCEPT_STAFF_INVITATION',
        'StaffInvitation',
        invitation.id,
        invitation.email,
        `Staff account activated as ${invitation.role} in ${invitation.department.name}`,
        undefined,
        tx,
      );

      return { user: targetUser };
    });

    // 6. Issue immediate authenticated session tokens
    const issued = await this.auth.issueTokens(user, undefined, req, res);

    return {
      success: true,
      message: 'Staff invitation accepted and account activated successfully',
      user: issued.user,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      token: issued.accessToken,
    };
  }
}
