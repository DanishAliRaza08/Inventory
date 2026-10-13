import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { serialize } from '../common/serialize.interceptor';
import { PrismaService, Tx } from '../prisma/prisma.service';
import type { AuthContext } from '../auth/decorators';

export interface AuditEntry {
  action: string; // e.g. product.create, listing.approve, cost.change, settings.kill_switch
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Append-only audit trail (UPDATE/DELETE are blocked by a database trigger). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(actor: Pick<AuthContext, 'userId' | 'email' | 'ip' | 'userAgent'> | null, entry: AuditEntry, tx?: Tx) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        actorId: actor?.userId ?? null,
        actorEmail: actor?.email ?? 'system',
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before === undefined ? Prisma.JsonNull : (serialize(entry.before) as Prisma.InputJsonValue),
        after: entry.after === undefined ? Prisma.JsonNull : (serialize(entry.after) as Prisma.InputJsonValue),
        ip: actor?.ip ?? null,
        userAgent: actor?.userAgent ?? null,
      },
    });
  }
}
