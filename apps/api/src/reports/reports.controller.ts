import { TtlCache } from '../common/ttl-cache';
import { config } from '../config';
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermissions } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { resolveRange } from '../dashboard/dashboard.controller';
import { zMarketplace } from '../finance/finance.schemas';
import { writeTable } from '../imports/tabular';
import { REPORTS, ReportsService } from './reports.service';

const Q = z.object({
  preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'this_month', 'last_month', 'this_year', 'custom']).default('last30'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  marketplace: zMarketplace.optional(),
  format: z.enum(['csv', 'xlsx']).default('csv'),
});

@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  private readonly cache = new TtlCache<unknown>(config().AGGREGATE_CACHE_SECONDS * 1000);

  constructor(private readonly reports: ReportsService) {}

  @Get()
  @RequirePermissions('reports.read')
  list() {
    return Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title }));
  }

  @Get(':key')
  @RequirePermissions('reports.read')
  run(@Param('key') key: string, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    const f = { ...resolveRange(q.preset, q.from, q.to), marketplace: q.marketplace };
    return this.cache.get(`${key}:${JSON.stringify(f)}`, () => this.reports.run(key, f, { limit: 1000 }));
  }

  @Get(':key/export')
  @RequirePermissions('reports.read', 'exports.run')
  async export(@Param('key') key: string, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>, @Res() res: Response) {
    const r = await this.reports.run(key, { ...resolveRange(q.preset, q.from, q.to), marketplace: q.marketplace });
    const headers = [...r.columns.map((c) => c.label), 'Data status'];
    const rows = r.rows.map((row) => Object.fromEntries([...r.columns.map((c) => [c.label, row[c.key] instanceof Date ? (row[c.key] as Date).toISOString() : row[c.key]]), ['Data status', r.dataStatus.label]]));
    const buf = await writeTable(q.format, headers, rows, r.title.slice(0, 30));
    res.setHeader('Content-Type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${key}-${new Date().toISOString().slice(0, 10)}.${q.format}"`);
    res.send(buf);
  }
}
