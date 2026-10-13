import { Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, AuthContext } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface NotifyInput {
  type: string;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  /** Deliver to everyone holding this role. */
  roleKey?: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(n: NotifyInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    return db.notification.create({ data: { ...n, severity: n.severity ?? 'info', body: n.body ?? '' } });
  }

  async forUser(auth: AuthContext, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: { OR: [{ userId: auth.userId }, { roleKey: { in: auth.roles } }, { userId: null, roleKey: null }], readAt: unreadOnly ? null : undefined },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markRead(auth: AuthContext, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, OR: [{ userId: auth.userId }, { roleKey: { in: auth.roles } }, { userId: null, roleKey: null }] },
      data: { readAt: new Date() },
    });
  }
}

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly n: NotificationsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query('unread') unread?: string) {
    return this.n.forUser(auth, unread === 'true');
  }

  @Post(':id/read')
  async read(@Auth() auth: AuthContext, @Param('id') id: string) {
    await this.n.markRead(auth, id);
    return { ok: true };
  }
}
