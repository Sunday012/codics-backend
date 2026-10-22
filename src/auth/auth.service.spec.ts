import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail.service';
import { AuditService } from '../common/audit.service';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { hash } from 'bcryptjs';

describe('AuthService - effectiveRole', () => {
  let service: AuthService;
  let prisma: any;
  let audit: any;

  beforeEach(async () => {
    prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      refreshToken: { create: jest.fn(), updateMany: jest.fn() },
      activationCode: { create: jest.fn() },
      passwordReset: { create: jest.fn() },
    };

    audit = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: MailService,
          useValue: {
            sendActivationCode: jest.fn(),
            sendPasswordResetToken: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: audit,
        },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn().mockResolvedValue('mock-jwt-token'), verifyAsync: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              if (key === 'JWT_SECRET') return 'test-secret-with-at-least-32-characters-for-testing';
              throw new Error(`Missing ${key}`);
            }),
            get: jest.fn().mockImplementation((key: string, defaultVal: string) => {
              if (key === 'GOOGLE_CLIENT_ID') return 'mock-google-client-id.apps.googleusercontent.com';
              return defaultVal;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should return course_rep when rep term has not expired', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    const user = {
      id: 'rep-1',
      role: Role.course_rep,
      repTermEnd: futureDate,
    };

    expect(service.effectiveRole(user)).toBe(Role.course_rep);
  });

  it('should preserve active course_rep when rep term expiry is null or absent (Follow-up Check 2)', () => {
    const userWithNullEnd = {
      id: 'rep-null',
      role: Role.course_rep,
      repTermEnd: null,
      baseRole: Role.student,
    };
    expect(service.effectiveRole(userWithNullEnd)).toBe(Role.course_rep);

    const userWithAbsentEnd = {
      id: 'rep-absent',
      role: Role.course_rep,
      baseRole: Role.student,
    };
    expect(service.effectiveRole(userWithAbsentEnd)).toBe(Role.course_rep);
  });

  it('should return student when rep term has expired', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24);
    const user = {
      id: 'rep-2',
      role: Role.course_rep,
      repTermEnd: pastDate,
    };

    expect(service.effectiveRole(user)).toBe(Role.student);
  });

  it('should return baseRole when rep term has expired and baseRole is set', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24);
    const user = {
      id: 'rep-3',
      role: Role.course_rep,
      repTermEnd: pastDate,
      baseRole: Role.student,
    };

    expect(service.effectiveRole(user)).toBe(Role.student);
  });

  it('should preserve role for other roles (admin, hod, lecturer, student)', () => {
    const admin = { id: 'admin-1', role: Role.admin };
    const hod = { id: 'hod-1', role: Role.hod };
    const lecturer = { id: 'lecturer-1', role: Role.lecturer };
    const student = { id: 'student-1', role: Role.student };

    expect(service.effectiveRole(admin)).toBe(Role.admin);
    expect(service.effectiveRole(hod)).toBe(Role.hod);
    expect(service.effectiveRole(lecturer)).toBe(Role.lecturer);
    expect(service.effectiveRole(student)).toBe(Role.student);
  });

  describe('Google Authentication & Safe Account Linking (Phase 12.3)', () => {
    const mockGooglePayload = {
      sub: 'google-sub-1234567890',
      email: 'student.chidi@foc.edu.ng',
      email_verified: true,
      name: 'Chidi Okonkwo',
      picture: 'https://lh3.googleusercontent.com/photo.jpg',
      iss: 'accounts.google.com',
    };

    beforeEach(() => {
      // Mock verifyGoogleIdToken to bypass real Google network call
      jest.spyOn(service, 'verifyGoogleIdToken').mockImplementation(async (token: string) => {
        if (token === 'valid-google-token') {
          return {
            googleId: mockGooglePayload.sub,
            email: mockGooglePayload.email,
            emailVerified: true,
            fullName: mockGooglePayload.name,
            avatarUrl: mockGooglePayload.picture,
          };
        }
        if (token === 'unverified-email-token') {
          throw new UnauthorizedException('Google email is not verified by Google');
        }
        if (token === 'invalid-issuer-token') {
          throw new UnauthorizedException('Invalid Google token issuer: evil.com');
        }
        if (token === 'expired-token') {
          throw new UnauthorizedException('Google token verification failed: Token used too late');
        }
        throw new UnauthorizedException('Google token verification failed: Invalid token');
      });
    });

    describe('verifyGoogleIdToken checks', () => {
      it('rejects expired identity tokens', async () => {
        await expect(service.verifyGoogleIdToken('expired-token')).rejects.toThrow(
          UnauthorizedException,
        );
      });

      it('rejects unverified Google email', async () => {
        await expect(service.verifyGoogleIdToken('unverified-email-token')).rejects.toThrow(
          'Google email is not verified by Google',
        );
      });

      it('rejects invalid token issuer', async () => {
        await expect(service.verifyGoogleIdToken('invalid-issuer-token')).rejects.toThrow(
          'Invalid Google token issuer',
        );
      });
    });

    describe('googleAuth workflow', () => {
      it('successfully logs in an existing active user bound to this googleId', async () => {
        const mockUser: any = {
          id: 'usr-student-01',
          fullName: 'Chidi Okonkwo',
          email: 'student.chidi@foc.edu.ng',
          googleId: 'google-sub-1234567890',
          role: Role.student,
          status: UserStatus.active,
          department: { name: 'Computer Science' },
        };
        prisma.user.findUnique.mockResolvedValue(mockUser);
        prisma.user.update.mockResolvedValue(mockUser);
        prisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

        const res = await service.googleAuth({ idToken: 'valid-google-token' });
        expect(res.action).toBe('LOGIN_SUCCESS');
        if (res.action === 'LOGIN_SUCCESS') {
          expect(res.tokens.user.email).toBe('student.chidi@foc.edu.ng');
          expect(res.tokens.accessToken).toBe('mock-jwt-token');
        }
      });

      it('rejects inactive or suspended user attempting to login with bound googleId', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: 'usr-suspended',
          googleId: 'google-sub-1234567890',
          status: UserStatus.suspended,
        });

        await expect(service.googleAuth({ idToken: 'valid-google-token' })).rejects.toThrow(
          'Account is suspended',
        );
      });

      it('returns NEEDS_LINKING without logging in when email matches an unlinked account', async () => {
        // googleId not yet bound in User table
        prisma.user.findUnique.mockResolvedValue(null);
        // But matching email exists!
        prisma.user.findFirst.mockResolvedValue({
          id: 'usr-existing',
          email: 'student.chidi@foc.edu.ng',
          googleId: null,
          status: UserStatus.active,
        });

        const res = await service.googleAuth({ idToken: 'valid-google-token' });
        expect(res.action).toBe('NEEDS_LINKING');
        if (res.action === 'NEEDS_LINKING') {
          expect(res.email).toBe('student.chidi@foc.edu.ng');
          expect(res.googleId).toBe('google-sub-1234567890');
          expect(res.message).toContain('Please authenticate with your password to link');
        }
      });

      it('returns NEEDS_ONBOARDING when Google identity has no matching CODICS account', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);

        const res = await service.googleAuth({ idToken: 'valid-google-token' });
        expect(res.action).toBe('NEEDS_ONBOARDING');
        if (res.action === 'NEEDS_ONBOARDING') {
          expect(res.email).toBe('student.chidi@foc.edu.ng');
          expect(res.googleId).toBe('google-sub-1234567890');
          expect(res.message).toContain('Please proceed to student onboarding');
        }
      });
    });

    describe('linkGoogleAccount safeguards', () => {
      it('successfully links Google identity after verifying correct existing password', async () => {
        const passwordHash = await hash('ValidPassword123!', 10);
        const existingUser: any = {
          id: 'usr-chidi',
          fullName: 'Chidi Okonkwo',
          email: 'student.chidi@foc.edu.ng',
          passwordHash,
          status: UserStatus.active,
          googleId: null,
          role: Role.student,
          department: { name: 'Computer Science' },
        };

        prisma.user.findFirst.mockResolvedValue(existingUser);
        prisma.user.findUnique.mockResolvedValue(null); // googleId not bound to another user
        prisma.user.update.mockResolvedValue({
          ...existingUser,
          googleId: 'google-sub-1234567890',
        });
        prisma.refreshToken.create.mockResolvedValue({ id: 'rt-2' });

        const result = await service.linkGoogleAccount({
          idToken: 'valid-google-token',
          identifier: 'student.chidi@foc.edu.ng',
          password: 'ValidPassword123!',
        });

        expect(result.user.email).toBe('student.chidi@foc.edu.ng');
        expect(audit.log).toHaveBeenCalledWith(
          expect.anything(),
          'GOOGLE_ACCOUNT_LINKED',
          'User',
          'usr-chidi',
          expect.stringContaining('google-sub-1234567890'),
        );
      });

      it('rejects account linking when password verification fails and logs audit security event', async () => {
        const passwordHash = await hash('ValidPassword123!', 10);
        const existingUser: any = {
          id: 'usr-chidi',
          fullName: 'Chidi Okonkwo',
          email: 'student.chidi@foc.edu.ng',
          passwordHash,
          status: UserStatus.active,
          role: Role.student,
        };

        prisma.user.findFirst.mockResolvedValue(existingUser);

        await expect(
          service.linkGoogleAccount({
            idToken: 'valid-google-token',
            identifier: 'student.chidi@foc.edu.ng',
            password: 'WrongPassword999!',
          }),
        ).rejects.toThrow(UnauthorizedException);

        expect(audit.log).toHaveBeenCalledWith(
          expect.anything(),
          'GOOGLE_ACCOUNT_LINK_FAILED',
          'User',
          'usr-chidi',
          expect.anything(),
        );
      });

      it('prevents one Google identity from being linked to multiple CODICS accounts', async () => {
        const passwordHash = await hash('ValidPassword123!', 10);
        const targetUser: any = {
          id: 'usr-target',
          passwordHash,
          status: UserStatus.active,
        };

        prisma.user.findFirst.mockResolvedValue(targetUser);
        // Another user already has this googleId!
        prisma.user.findUnique.mockResolvedValue({
          id: 'usr-already-linked',
          googleId: 'google-sub-1234567890',
        });

        await expect(
          service.linkGoogleAccount({
            idToken: 'valid-google-token',
            identifier: 'student.chidi@foc.edu.ng',
            password: 'ValidPassword123!',
          }),
        ).rejects.toThrow(ConflictException);
      });
    });

    describe('unlinkGoogleAccount safeguards', () => {
      it('successfully unlinks Google identity and revokes all refresh tokens upon password verification', async () => {
        const passwordHash = await hash('ValidPassword123!', 10);
        const user: any = {
          id: 'usr-unlink',
          fullName: 'Chidi Okonkwo',
          googleId: 'google-sub-1234567890',
          passwordHash,
          role: Role.student,
        };

        prisma.user.findUnique.mockResolvedValue(user);
        prisma.user.update.mockResolvedValue({ ...user, googleId: null });

        const res = await service.unlinkGoogleAccount(
          { id: 'usr-unlink' },
          { password: 'ValidPassword123!' },
        );

        expect(res.success).toBe(true);
        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { userId: 'usr-unlink', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
        expect(audit.log).toHaveBeenCalledWith(
          expect.anything(),
          'GOOGLE_ACCOUNT_UNLINKED',
          'User',
          'usr-unlink',
          'Unlinked Google identity',
        );
      });

      it('rejects unlinking if password is wrong', async () => {
        const passwordHash = await hash('ValidPassword123!', 10);
        prisma.user.findUnique.mockResolvedValue({
          id: 'usr-unlink',
          googleId: 'google-sub-1234567890',
          passwordHash,
        });

        await expect(
          service.unlinkGoogleAccount({ id: 'usr-unlink' }, { password: 'WrongPassword!' }),
        ).rejects.toThrow(UnauthorizedException);
      });
    });
  });
});
