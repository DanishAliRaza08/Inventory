import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermissions } from '../auth/decorators';
import { ZodPipe, zPagination } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

const Q = zPagination.extend({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
});

@ApiTags('Audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('audit.read')
  async list(@Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    const where = {
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      action: q.action ? { startsWith: q.action } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
