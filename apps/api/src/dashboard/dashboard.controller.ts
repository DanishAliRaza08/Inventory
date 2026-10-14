import { TtlCache } from '../common/ttl-cache';
import { config } from '../config';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermissions } from '../auth/decorators';
import { ApiZodQuery, ZodPipe } from '../common/zod';
import { zMarketplace } from '../finance/finance.schemas';
import { DashboardFilter, DashboardService } from './dashboard.service';

const PRESETS = ['today', 'yesterday', 'last7', 'last30', 'this_month', 'last_month', 'this_year', 'custom'] as const;

export function resolveRange(preset: (typeof PRESETS)[number], from?: Date, to?: Date, now = new Date()): { from: Date; to: Date } {
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const today = startOfDay(now);
  const day = 86_400_000;
  switch (preset) {
    case 'today':
      return { from: today, to: new Date(today.getTime() + day) };
    case 'yesterday':
      return { from: new Date(today.getTime() - day), to: today };
    case 'last7':
      return { from: new Date(today.getTime() - 6 * day), to: new Date(today.getTime() + day) };
    case 'last30':
      return { from: new Date(today.getTime() - 29 * day), to: new Date(today.getTime() + day) };
    case 'this_month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
    case 'last_month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
    case 'this_year':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) };
    case 'custom':
      if (!from || !to) throw new Error('Custom range needs from and to');
      return { from, to };
  }
}

const Q = z
  .object({
    preset: z.enum(PRESETS).default('last30'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    marketplace: zMarketplace.optional(),
    variantId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    bucket: z.enum(['day', 'week', 'month']).default('day'),
  })
  .refine((q) => q.preset !== 'custom' || (q.from && q.to && q.from < q.to), { message: 'Custom range needs from < to' });

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  // Month-wide aggregates over every order line: cached briefly so repeated page loads are instant.
  private readonly cache = new TtlCache<unknown>(config().AGGREGATE_CACHE_SECONDS * 1000);

  constructor(private readonly dashboard: DashboardService) {}

  private filter(q: z.infer<typeof Q>): DashboardFilter {
    return { ...resolveRange(q.preset, q.from, q.to), marketplace: q.marketplace, variantId: q.variantId, supplierId: q.supplierId };
  }

  @Get('summary')
  @RequirePermissions('products.read')
  @ApiZodQuery(Q.innerType())
  async summary(@Query(new ZodPipe(Q)) q: z.infer<typeof Q>, @Query('_') _?: string) {
    const f = this.filter(q);
    return this.cache.get(`summary:${JSON.stringify(f)}`, () => this.dashboard.summary(f));
  }

  @Get('timeseries')
  @RequirePermissions('finance.read')
  timeseries(@Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    const f = this.filter(q);
    return this.cache.get(`series:${q.bucket}:${JSON.stringify(f)}`, () => this.dashboard.timeseries(f, q.bucket));
  }
}
