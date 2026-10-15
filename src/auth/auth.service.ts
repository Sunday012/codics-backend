import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { DataService } from '../data/data.service';
import { SafeUser, User, toSafeUser } from '../data/entities';
import { ActivateDto, LoginDto } from './auth.dto';

interface TokenPayload {
  sub: string;
  role: string;
  type: 'access' | 'refresh';
}

@Injectable()
export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtTtl: string;
  private readonly refreshTtl: string;

  constructor(
    private readonly data: DataService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');
    this.jwtTtl = this.config.get<string>('JWT_TTL', '15m');
    this.refreshTtl = this.config.get<string>('REFRESH_TOKEN_TTL', '7d');
  }

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim().toLowerCase();
    const user = this.data.db.users.find((candidate) =>
      [candidate.email, candidate.matricNo, candidate.staffId]
        .filter(Boolean)
        .some((value) => value!.toLowerCase() === identifier),
    );
    if (!user || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid matric number / email or password');
    }
    if (user.status !== 'active') throw new UnauthorizedException(`Account is ${user.status}`);
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(refreshToken, {
        secret: this.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type');
    const user = this.data.db.users.find((candidate) => candidate.id === payload.sub);
    if (!user?.refreshTokenHash || !(await compare(refreshToken, user.refreshTokenHash))) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }
    return this.issueTokens(user);
  }

  async logout(user: User) {
    delete user.refreshTokenHash;
    await this.data.save();
    return { success: true };
  }

  async activate(dto: ActivateDto) {
    const user = this.data.db.users.find(
      (candidate) => candidate.matricNo?.toLowerCase() === dto.matricNo.toLowerCase(),
    );
    if (!user) throw new BadRequestException('Student is not present on the approved roster');
    if (user.status === 'active') throw new BadRequestException('Account is already active');
    // Replace this deterministic development code with an SMS/email provider in production.
    if (dto.activationCode !== 'CODICS') throw new BadRequestException('Invalid activation code');
    user.passwordHash = await hash(dto.password, 12);
    user.status = 'active';
    if (dto.email) user.email = dto.email;
    await this.data.save();
    return this.issueTokens(user);
  }

  async issueTokens(
    user: User,
  ): Promise<{ user: SafeUser; accessToken: string; refreshToken: string; token: string }> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: this.effectiveRole(user), type: 'access' } satisfies TokenPayload,
      { secret: this.jwtSecret, expiresIn: this.jwtTtl as any },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, role: this.effectiveRole(user), type: 'refresh' } satisfies TokenPayload,
      { secret: this.jwtSecret, expiresIn: this.refreshTtl as any },
    );
    user.refreshTokenHash = await hash(refreshToken, 10);
    await this.data.save();
    return {
      user: { ...toSafeUser(user), role: this.effectiveRole(user) },
      accessToken,
      refreshToken,
      token: accessToken,
    };
  }

  effectiveRole(user: User): User['role'] {
    if (
      user.role === 'course_rep' &&
      user.repTermEndDate &&
      new Date(user.repTermEndDate) < new Date()
    ) {
      return 'student';
    }
    return user.role;
  }
}
