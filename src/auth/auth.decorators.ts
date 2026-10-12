import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role, User } from '../data/entities';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => context.switchToHttp().getRequest().user,
);
