import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { DataService } from '../data/data.service';
import { User } from '../data/entities';

describe('AuthService - effectiveRole', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: DataService,
          useValue: { db: { users: [] }, save: jest.fn() },
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
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    const user = {
      id: 'rep-1',
      role: 'course_rep',
      repTermEndDate: futureDate,
    } as unknown as User;

    expect(service.effectiveRole(user)).toBe('course_rep');
  });

  it('should return student when rep term has expired', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    const user = {
      id: 'rep-2',
      role: 'course_rep',
      repTermEndDate: pastDate,
    } as unknown as User;

    expect(service.effectiveRole(user)).toBe('student');
  });

  it('should preserve role for other roles (admin, hod, lecturer, student)', () => {
    const admin = { id: 'admin-1', role: 'admin' } as unknown as User;
    const hod = { id: 'hod-1', role: 'hod' } as unknown as User;
    const lecturer = { id: 'lecturer-1', role: 'lecturer' } as unknown as User;
    const student = { id: 'student-1', role: 'student' } as unknown as User;

    expect(service.effectiveRole(admin)).toBe('admin');
    expect(service.effectiveRole(hod)).toBe('hod');
    expect(service.effectiveRole(lecturer)).toBe('lecturer');
    expect(service.effectiveRole(student)).toBe('student');
  });
});
