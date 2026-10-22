import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role, RoleScopeType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuthService } from '../auth/auth.service';
import { StaffInvitationService } from './staff-invitation.service';

describe('Phase 12.2: Staff Invitations Implementation', () => {
  let service: StaffInvitationService;
  let prisma: any;
  let auth: any;
  let mail: any;
  let audit: any;
  let config: any;

  const mockAdminActor = {
    id: 'usr-admin-01',
    fullName: 'Prof. Florence Nnamdi',
    email: 'dean.computing@foc.edu.ng',
    role: Role.admin,
    departmentId: 'dept-cs-id',
  };

  const mockHodActor = {
    id: 'usr-hod-01',
    fullName: 'Dr. Grace Okafor',
    email: 'hod.cs@foc.edu.ng',
    role: Role.hod,
    departmentId: 'dept-cs-id',
  };

  const mockLecturerActor = {
    id: 'usr-lecturer-01',
    fullName: 'Dr. Ibrahim Adeleke',
    email: 'i.adeleke@foc.edu.ng',
    role: Role.lecturer,
    departmentId: 'dept-cs-id',
  };

  const mockDeptCs = {
    id: 'dept-cs-id',
    name: 'Computer Science',
    code: 'CSC',
  };

  const mockDeptSe = {
    id: 'dept-se-id',
    name: 'Software Engineering',
    code: 'SEN',
  };

  beforeEach(() => {
    prisma = {
      department: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          if (where.id === mockDeptCs.id) return mockDeptCs;
          if (where.id === mockDeptSe.id) return mockDeptSe;
          return null;
        }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: `usr-new-${Date.now()}`,
          ...data,
        })),
        update: jest.fn().mockImplementation(async ({ data, where }) => ({
          id: where.id,
          ...data,
        })),
      },
      staffInvitation: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: 'inv-123',
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn().mockImplementation(async ({ where, data }) => ({
          id: where.id,
          ...data,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      roleAssignment: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: 'role-assign-123',
          ...data,
        })),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(prisma);
      }),
    };

    auth = {
      issueTokens: jest.fn().mockResolvedValue({
        user: { id: 'usr-mock', fullName: 'Mock Staff', role: Role.lecturer },
        accessToken: 'mock-jwt-access-token',
        refreshToken: 'mock-refresh-token',
        token: 'mock-jwt-access-token',
      }),
    };

    mail = {
      sendStaffInvitation: jest.fn().mockResolvedValue({
        status: 'sent',
        provider: 'resend',
        maskedRecipient: 't***@foc.edu.ng',
      }),
    };

    audit = {
      log: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    };

    config = {
      get: jest.fn((key: string) => {
        if (key === 'FRONTEND_URL') return 'https://portal.foc.edu.ng';
        return undefined;
      }),
    };

    service = new StaffInvitationService(prisma, auth, mail, audit, config);
  });

  describe('1. Invitation Creation & Authorization Matrix', () => {
    it('allows System Admin to invite a lecturer to any department', async () => {
      const res = await service.createInvitation(mockAdminActor, {
        email: 'new.lecturer@foc.edu.ng',
        fullName: 'Dr. New Lecturer',
        role: Role.lecturer,
        departmentId: mockDeptSe.id,
      });

      expect(res.id).toBe('inv-123');
      expect(res.email).toBe('new.lecturer@foc.edu.ng');
      expect(res.role).toBe(Role.lecturer);
      expect(res.departmentId).toBe(mockDeptSe.id);
      expect(res.token).toBeDefined();
      expect(res.token).toHaveLength(64); // 32 bytes hex = 64 characters
      expect(res.invitationLink).toContain(`token=${res.token}`);
      expect(res.invitationLink).toContain('https://portal.foc.edu.ng/accept-invitation');

      // Verify token hashing: DB should store SHA-256 hash, NOT raw token
      const expectedHash = createHash('sha256').update(res.token).digest('hex');
      expect(prisma.staffInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tokenHash: expectedHash,
            status: 'pending',
          }),
        }),
      );

      // Verify email was sent
      expect(mail.sendStaffInvitation).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        mockAdminActor,
        'CREATE_STAFF_INVITATION',
        'StaffInvitation',
        'inv-123',
        'new.lecturer@foc.edu.ng',
        expect.any(String),
        undefined,
        expect.anything(),
      );
    });

    it('allows System Admin to invite an HOD or another Admin', async () => {
      const resHod = await service.createInvitation(mockAdminActor, {
        email: 'new.hod@foc.edu.ng',
        fullName: 'Prof. Incoming HOD',
        role: Role.hod,
        departmentId: mockDeptCs.id,
      });
      expect(resHod.role).toBe(Role.hod);

      const resAdmin = await service.createInvitation(mockAdminActor, {
        email: 'new.admin@foc.edu.ng',
        fullName: 'Engr. System Admin',
        role: Role.admin,
        departmentId: mockDeptCs.id,
      });
      expect(resAdmin.role).toBe(Role.admin);
    });

    it('allows HOD to invite a lecturer within their own department', async () => {
      const res = await service.createInvitation(mockHodActor, {
        email: 'dept.lecturer@foc.edu.ng',
        fullName: 'Dr. CS Lecturer',
        role: Role.lecturer,
        departmentId: mockDeptCs.id,
      });

      expect(res.role).toBe(Role.lecturer);
      expect(res.departmentId).toBe(mockDeptCs.id);
    });

    it('prevents HOD from inviting an Admin (Unauthorized Role Assignment)', async () => {
      await expect(
        service.createInvitation(mockHodActor, {
          email: 'rogue.admin@foc.edu.ng',
          fullName: 'Fake Admin',
          role: Role.admin,
          departmentId: mockDeptCs.id,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents HOD from inviting another HOD (Unauthorized Role Assignment)', async () => {
      await expect(
        service.createInvitation(mockHodActor, {
          email: 'duplicate.hod@foc.edu.ng',
          fullName: 'Second HOD',
          role: Role.hod,
          departmentId: mockDeptCs.id,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents HOD from inviting staff outside their department (Cross-Department Access Attempt)', async () => {
      await expect(
        service.createInvitation(mockHodActor, {
          email: 'se.lecturer@foc.edu.ng',
          fullName: 'Dr. SE Lecturer',
          role: Role.lecturer,
          departmentId: mockDeptSe.id, // Different department!
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('strictly forbids standard lecturers, course reps, or students from inviting staff', async () => {
      await expect(
        service.createInvitation(mockLecturerActor, {
          email: 'peer@foc.edu.ng',
          fullName: 'Dr. Peer',
          role: Role.lecturer,
          departmentId: mockDeptCs.id,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects invitation creation if department does not exist', async () => {
      await expect(
        service.createInvitation(mockAdminActor, {
          email: 'ghost@foc.edu.ng',
          fullName: 'Ghost Staff',
          role: Role.lecturer,
          departmentId: 'non-existent-dept',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects invitation if an active staff already exists with that email and role in that department', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'usr-existing-staff',
        email: 'active.staff@foc.edu.ng',
        role: Role.lecturer,
        departmentId: mockDeptCs.id,
        status: 'active',
      });

      await expect(
        service.createInvitation(mockAdminActor, {
          email: 'active.staff@foc.edu.ng',
          fullName: 'Active Staff Member',
          role: Role.lecturer,
          departmentId: mockDeptCs.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('2. Email Delivery Failure & Copy-Link Fallback', () => {
    it('creates invitation and returns valid invitationLink even if mail delivery throws an error', async () => {
      mail.sendStaffInvitation.mockRejectedValueOnce(
        new Error('SMTP connection timed out'),
      );

      const res = await service.createInvitation(mockAdminActor, {
        email: 'fallback@foc.edu.ng',
        fullName: 'Dr. Fallback Staff',
        role: Role.lecturer,
        departmentId: mockDeptCs.id,
      });

      // Invitation is still created and stored safely
      expect(res.id).toBe('inv-123');
      expect(res.token).toBeDefined();
      expect(res.invitationLink).toContain('token=');
      // Email delivery failure is recorded gracefully without crashing
      expect(res.emailDelivery.status).toBe('failed');
      expect(prisma.staffInvitation.create).toHaveBeenCalled();
    });
  });

  describe('3. Public Token Verification & Tampering Protection', () => {
    it('verifies a valid pending token and returns metadata without exposing secrets', async () => {
      const rawToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-valid',
        email: 'prospective.lecturer@foc.edu.ng',
        fullName: 'Dr. Prospective',
        role: Role.lecturer,
        departmentId: mockDeptCs.id,
        tokenHash,
        status: 'pending',
        expiresAt: new Date(Date.now() + 1000000),
        department: mockDeptCs,
      });

      const res = await service.verifyInvitationToken(rawToken);

      expect(res.valid).toBe(true);
      expect(res.email).toBe('prospective.lecturer@foc.edu.ng');
      expect(res.fullName).toBe('Dr. Prospective');
      expect(res.role).toBe(Role.lecturer);
      expect(res.departmentName).toBe('Computer Science');
      // Must not expose tokenHash
      expect((res as any).tokenHash).toBeUndefined();
    });

    it('rejects tampered or invalid tokens with NotFoundException', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.verifyInvitationToken('tampered_token_that_does_not_exist_in_db_12345'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects short or empty tokens', async () => {
      await expect(service.verifyInvitationToken('')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.verifyInvitationToken('short')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects verification if invitation is already accepted', async () => {
      const rawToken = 'already_accepted_token_1234567890';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-accepted',
        tokenHash,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 1000000),
        department: mockDeptCs,
      });

      await expect(service.verifyInvitationToken(rawToken)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects verification if invitation is revoked', async () => {
      const rawToken = 'revoked_token_1234567890_secure';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-revoked',
        tokenHash,
        status: 'revoked',
        expiresAt: new Date(Date.now() + 1000000),
        department: mockDeptCs,
      });

      await expect(service.verifyInvitationToken(rawToken)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects verification and marks expired if expiration date has passed', async () => {
      const rawToken = 'expired_token_1234567890_secure';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-expired',
        tokenHash,
        status: 'pending',
        expiresAt: new Date(Date.now() - 10000), // in the past!
        department: mockDeptCs,
      });

      await expect(service.verifyInvitationToken(rawToken)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.staffInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-expired' },
          data: { status: 'expired' },
        }),
      );
    });
  });

  describe('4. Atomic Acceptance & Concurrency / Replay Prevention', () => {
    const rawToken = 'valid_secret_acceptance_token_123456';
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const pendingInvitation = {
      id: 'inv-accept-1',
      email: 'accept.lecturer@foc.edu.ng',
      fullName: 'Dr. Jane Accepted',
      role: Role.lecturer,
      departmentId: mockDeptCs.id,
      tokenHash,
      status: 'pending',
      expiresAt: new Date(Date.now() + 500000),
      invitedById: mockAdminActor.id,
      department: mockDeptCs,
    };

    it('successfully accepts invitation, provisions new user, and issues tokens', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce(pendingInvitation);
      prisma.staffInvitation.updateMany.mockResolvedValueOnce({ count: 1 }); // Atomic CAS succeeds
      prisma.user.findUnique.mockResolvedValueOnce(null); // New user

      const res = await service.acceptInvitation({
        token: rawToken,
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });

      expect(res.success).toBe(true);
      expect(res.accessToken).toBe('mock-jwt-access-token');

      // Verify User was created with active status and lecturer baseRole
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'accept.lecturer@foc.edu.ng',
            fullName: 'Dr. Jane Accepted',
            role: Role.lecturer,
            baseRole: Role.lecturer,
            status: 'active',
          }),
        }),
      );

      // Verify audit log
      expect(audit.log).toHaveBeenCalledWith(
        expect.anything(),
        'ACCEPT_STAFF_INVITATION',
        'StaffInvitation',
        'inv-accept-1',
        'accept.lecturer@foc.edu.ng',
        expect.any(String),
        undefined,
        expect.anything(),
      );
    });

    it('sets baseRole to lecturer when accepting an HOD invitation (Follow-up Check 1)', async () => {
      const hodInvitation = {
        ...pendingInvitation,
        id: 'inv-hod-accept',
        role: Role.hod,
      };

      prisma.staffInvitation.findUnique.mockResolvedValueOnce(hodInvitation);
      prisma.staffInvitation.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await service.acceptInvitation({
        token: rawToken,
        password: 'Password123!',
      });

      // Crucial verification: HOD's underlying baseRole must be lecturer, not student!
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: Role.hod,
            baseRole: Role.lecturer,
          }),
        }),
      );

      // Official RoleAssignment must also be created
      expect(prisma.roleAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: Role.hod,
            scopeType: RoleScopeType.department,
            scopeId: mockDeptCs.id,
            isActive: true,
          }),
        }),
      );
    });

    it('updates existing user when recipient already has an account', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce(pendingInvitation);
      prisma.staffInvitation.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'usr-existing',
        email: 'accept.lecturer@foc.edu.ng',
        fullName: 'Jane Existing',
        role: Role.student,
        baseRole: Role.student,
        departmentId: mockDeptCs.id,
        activatedAt: new Date('2025-01-01'),
      });

      await service.acceptInvitation({
        token: rawToken,
        password: 'NewStrongPassword123!',
      });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'usr-existing' },
          data: expect.objectContaining({
            role: Role.lecturer,
            baseRole: Role.lecturer,
            status: 'active',
          }),
        }),
      );
    });

    it('prevents concurrent acceptance and replay via atomic compare-and-swap (CAS)', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce(pendingInvitation);
      // Simulate race condition where another concurrent worker won the race
      prisma.staffInvitation.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.acceptInvitation({
          token: rawToken,
          password: 'Password123!',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects passwords shorter than 8 characters', async () => {
      await expect(
        service.acceptInvitation({
          token: rawToken,
          password: 'short',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects mismatched password and confirmPassword', async () => {
      await expect(
        service.acceptInvitation({
          token: rawToken,
          password: 'Password123!',
          confirmPassword: 'MismatchPassword!',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('5. Scoped Listing & Revocation', () => {
    it('restricts HOD to listing only invitations in their department', async () => {
      prisma.staffInvitation.count.mockResolvedValue(1);
      prisma.staffInvitation.findMany.mockResolvedValue([
        {
          id: 'inv-cs-1',
          email: 'cs.staff@foc.edu.ng',
          fullName: 'CS Staff',
          role: Role.lecturer,
          departmentId: mockDeptCs.id,
          status: 'pending',
          department: mockDeptCs,
          invitedBy: mockHodActor,
          acceptedBy: null,
        },
      ]);

      const res = await service.listInvitations(mockHodActor, {});

      expect(res.total).toBe(1);
      expect(prisma.staffInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            departmentId: mockDeptCs.id,
          }),
        }),
      );
    });

    it('throws ForbiddenException if HOD tries to list invitations of another department', async () => {
      await expect(
        service.listInvitations(mockHodActor, { departmentId: mockDeptSe.id }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows Admin to list invitations across any or all departments', async () => {
      prisma.staffInvitation.count.mockResolvedValue(5);
      prisma.staffInvitation.findMany.mockResolvedValue([]);

      const res = await service.listInvitations(mockAdminActor, {
        departmentId: mockDeptSe.id,
      });

      expect(res.total).toBe(5);
      expect(prisma.staffInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            departmentId: mockDeptSe.id,
          }),
        }),
      );
    });

    it('allows HOD to revoke a pending invitation in their department', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-dept-cs',
        email: 'revoke.me@foc.edu.ng',
        departmentId: mockDeptCs.id,
        status: 'pending',
      });

      const res = await service.revokeInvitation(mockHodActor, 'inv-dept-cs');
      expect(res.status).toBe('revoked');
      expect(prisma.staffInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-dept-cs' },
        data: { status: 'revoked' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        mockHodActor,
        'REVOKE_STAFF_INVITATION',
        'StaffInvitation',
        'inv-dept-cs',
        'revoke.me@foc.edu.ng',
        expect.any(String),
      );
    });

    it('prevents HOD from revoking an invitation belonging to another department', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-dept-se',
        email: 'other.dept@foc.edu.ng',
        departmentId: mockDeptSe.id, // Different department
        status: 'pending',
      });

      await expect(
        service.revokeInvitation(mockHodActor, 'inv-dept-se'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents revoking an already accepted invitation', async () => {
      prisma.staffInvitation.findUnique.mockResolvedValueOnce({
        id: 'inv-accepted',
        departmentId: mockDeptCs.id,
        status: 'accepted',
      });

      await expect(
        service.revokeInvitation(mockAdminActor, 'inv-accepted'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('6. Phase 12.1 Follow-up Checks', () => {
    it('Follow-up Check 2: active role assignment with nullable or absent expiry date remains active', () => {
      const mockConfig: any = {
        getOrThrow: jest.fn(() => 'jwt-test-secret'),
        get: jest.fn((key: string, def?: any) => def ?? 'mock-val'),
      };
      const mockAuthService = new AuthService(null as any, null as any, mockConfig, null as any);

      // Test the effectiveRole logic with null and undefined expiry dates
      const activeRepWithNullEnd: any = {
        role: Role.course_rep,
        repTermEnd: null,
        baseRole: Role.student,
      };
      expect(mockAuthService.effectiveRole(activeRepWithNullEnd)).toBe(
        Role.course_rep,
      );

      const activeRepWithUndefinedEnd: any = {
        role: Role.course_rep,
        repTermEnd: undefined,
        baseRole: Role.student,
      };
      expect(mockAuthService.effectiveRole(activeRepWithUndefinedEnd)).toBe(
        Role.course_rep,
      );

      const expiredRep: any = {
        role: Role.course_rep,
        repTermEnd: new Date('2020-01-01'), // in the past
        baseRole: Role.student,
      };
      expect(mockAuthService.effectiveRole(expiredRep)).toBe(
        Role.student,
      );
    });
  });
});
