import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { IS_PUBLIC_KEY } from './auth.decorators';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private config: ConfigService, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest();
    const [kind, token] = request.headers.authorization?.split(' ') ?? [];
    if (kind !== 'Bearer' || !token) throw new UnauthorizedException('Bearer token required');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(token, {
        secret: this.config.get<string>('JWT_SECRET', 'development-secret-change-me'),
      });
      if (payload.type !== 'access') throw new Error('wrong token type');
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.status !== 'active') throw new Error('inactive account');
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
