import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { SafeUser } from '../common/user.util';
import { ROLES_KEY } from './auth.decorators';
import { AuthService } from './auth.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector, private auth: AuthService) {}
  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest().user as SafeUser;
    if (user && roles.includes(this.auth.effectiveRole(user))) return true;
    throw new ForbiddenException('You do not have permission to perform this action');
  }
}
