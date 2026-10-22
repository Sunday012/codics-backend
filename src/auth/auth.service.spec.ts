import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail.service';

describe('AuthService - effectiveRole', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
            refreshToken: { create: jest.fn(), updateMany: jest.fn() },
            activationCode: { create: jest.fn() },
            passwordReset: { create: jest.fn() },
          },
        },
        {
          provide: MailService,
          useValue: {
            sendActivationCode: jest.fn(),
            sendPasswordResetToken: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn(), verifyAsync: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              if (key === 'JWT_SECRET') return 'test-secret-with-at-least-32-characters-for-testing';
              throw new Error(`Missing ${key}`);
            }),
            get: jest.fn().mockImplementation((key: string, defaultVal: string) => defaultVal),
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
});
