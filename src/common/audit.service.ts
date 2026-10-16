import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, User } from '@prisma/client';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    actor: Pick<User, 'id' | 'fullName' | 'role'> | { id?: string; fullName?: string; name?: string; role?: string } | null,
    action: string,
    targetType: string,
    targetId: string,
    targetName?: string,
    reason?: string,
    metadata?: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx || this.prisma;
    const actorName = actor ? ('fullName' in actor && actor.fullName ? actor.fullName : (actor as any).name) : null;
    return client.auditLog.create({
      data: {
        actorId: actor?.id || null,
        actorName: actorName || null,
        actorRole: actor?.role || null,
        action,
        targetType,
        targetId,
        targetName: targetName || null,
        reason: reason || null,
        metadata: metadata ?? Prisma.JsonNull,
      },
    });
  }
}
