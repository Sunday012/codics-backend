import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { SafeUser, User, toSafeUser } from '../data/entities';
import { ActivateDto, LoginDto } from './auth.dto';

interface TokenPayload { sub: string; role: string; type: 'access' | 'refresh' }

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({ where: { OR: [
      { email: { equals: identifier, mode: 'insensitive' } },
      { matricNo: { equals: identifier, mode: 'insensitive' } },
      { staffId: { equals: identifier, mode: 'insensitive' } },
    ] } });
    if (!user || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid matric number / email or password');
    }
    if (user.status !== 'active') throw new UnauthorizedException(`Account is ${user.status}`);
    return this.issueTokens(user as unknown as User);
  }

  async refresh(refreshToken: string) {
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_SECRET', 'development-secret-change-me'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.refreshTokenHash || !(await compare(refreshToken, user.refreshTokenHash))) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }
    return this.issueTokens(user as unknown as User);
  }

  async logout(user: User) {
    await this.prisma.user.update({ where: { id: user.id }, data: { refreshTokenHash: null } });
    return { success: true };
  }

  async activate(dto: ActivateDto) {
    const user = await this.prisma.user.findFirst({ where: { matricNo: { equals: dto.matricNo, mode: 'insensitive' } } });
    if (!user) throw new BadRequestException('Student is not present on the approved roster');
    if (user.status === 'active') throw new BadRequestException('Account is already active');
    // Replace this deterministic development code with an SMS/email provider in production.
    if (dto.activationCode !== 'CODICS') throw new BadRequestException('Invalid activation code');
    const activated = await this.prisma.user.update({ where: { id: user.id }, data: {
      passwordHash: await hash(dto.password, 12), status: 'active', ...(dto.email ? { email: dto.email } : {}),
    } });
    return this.issueTokens(activated as unknown as User);
  }

  async issueTokens(user: User): Promise<{ user: SafeUser; accessToken: string; refreshToken: string; token: string }> {
    const secret = this.config.get<string>('JWT_SECRET', 'development-secret-change-me');
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: this.effectiveRole(user), type: 'access' } satisfies TokenPayload,
      { secret, expiresIn: this.config.get('JWT_TTL', '15m') },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, role: this.effectiveRole(user), type: 'refresh' } satisfies TokenPayload,
      { secret, expiresIn: this.config.get('REFRESH_TOKEN_TTL', '7d') },
    );
    const refreshTokenHash = await hash(refreshToken, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { refreshTokenHash } });
    return { user: { ...toSafeUser(user), role: this.effectiveRole(user) }, accessToken, refreshToken, token: accessToken };
  }

  effectiveRole(user: User): User['role'] {
    if (user.role === 'course_rep' && user.repTermEndDate && new Date(user.repTermEndDate) < new Date()) return 'student';
    return user.role;
  }
}
