import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataService } from '../data/data.service';
import { IS_PUBLIC_KEY } from './auth.decorators';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwtSecret: string;

  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    config: ConfigService,
    private data: DataService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const [kind, token] = request.headers.authorization?.split(' ') ?? [];
    if (kind !== 'Bearer' || !token) {
      throw new UnauthorizedException('Bearer token required');
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(token, {
        secret: this.jwtSecret,
      });
      if (payload.type !== 'access') throw new Error('wrong token type');
      const user = this.data.db.users.find((candidate) => candidate.id === payload.sub);
      if (!user || user.status !== 'active') throw new Error('inactive account');
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
