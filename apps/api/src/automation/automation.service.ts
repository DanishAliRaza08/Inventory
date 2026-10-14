import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AutomationRule, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { RepricingService } from '../listings/repricing.service';
import { PublicationService } from '../listings/publication.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Rule kinds. Each has an explicit, validated condition config, a fixed set of allowed actions
 * and is evaluated on a schedule (minutes). Thresholds are configuration, never hard-coded.
 */
export const RULE_KINDS = {
  LOW_PROFIT_LISTINGS: { label: 'Live listings below a profit or margin threshold', conditions: z.object({ minMarginPercent: z.number().min(0).max(99).default(15) }), actions: ['NOTIFY', 'PROPOSE_REPRICE'] },
  SUPPLIER_OUT_OF_STOCK: { label: 'Supplier stock unavailable for live dropship listings', conditions: z.object({}), actions: ['NOTIFY', 'PAUSE_LISTINGS'] },
  SUPPLIER_COST_INCREASE: { label: 'Supplier price increased', conditions: z.object({ percent: z.number().positive().default(5), withinHours: z.number().positive().default(24) }), actions: ['NOTIFY'] },
  DISPATCH_DEADLINE: { label: 'Orders approaching their dispatch deadline', conditions: z.object({ withinHours: z.number().positive().default(24) }), actions: ['NOTIFY'] },
  DRAFTS_AWAITING_APPROVAL: { label: 'Drafts waiting for approval', conditions: z.object({ olderThanHours: z.number().nonnegative().default(4) }), actions: ['NOTIFY'] },
  PUBLICATION_FAILURES: { label: 'Listings that failed to publish', conditions: z.object({ withinHours: z.number().positive().default(24) }), actions: ['NOTIFY'] },
  STALE_SUPPLIER_DATA: { label: 'Supplier stock data older than a threshold', conditions: z.object({ olderThanHours: z.number().positive().default(48) }), actions: ['NOTIFY'] },
  DAILY_SALES_REPORT: { label: 'Daily sales and profit summary', conditions: z.object({}), actions: ['NOTIFY'] },
} as const;
export type RuleKind = keyof typeof RULE_KINDS;

export const RuleInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(Object.keys(RULE_KINDS) as [RuleKind, ...RuleKind[]]),
  conditions: z.record(z.unknown()).default({}),
  action: z.enum(['NOTIFY', 'PROPOSE_REPRICE', 'PAUSE_LISTINGS']),
  notifyRole: z.string().default('owner'),
  everyMinutes: z.number().int().min(15).max(10_080).default(60),
  enabled: z.boolean().default(false),
  /** Live-affecting actions (pausing listings) only run automatically when this is false. */
  requiresApproval: z.boolean().default(true),
});

export interface Match {
  entityType: string;
  entityId: string;
  summary: string;
}

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly repricing: RepricingService,
    private readonly publication: PublicationService,
    private readonly audit: AuditService,
  ) {}

  validate(input: z.infer<typeof RuleInput>) {
    const def = RULE_KINDS[input.kind];
    if (!(def.actions as readonly string[]).includes(input.action)) throw new BadRequestException({ code: 'ACTION_NOT_ALLOWED', message: `${input.action} is not available for ${def.label}.` });
    return { ...input, conditions: def.conditions.parse(input.conditions) };
  }

  async create(input: z.infer<typeof RuleInput>, actor: AuthContext) {
    const v = this.validate(input);
    const rule = await this.prisma.automationRule.create({
      data: { name: v.name, trigger: v.kind, conditions: v.conditions as Prisma.InputJsonValue, actions: { action: v.action, notifyRole: v.notifyRole }, schedule: String(v.everyMinutes), enabled: v.enabled, requiresApproval: v.requiresApproval, createdById: actor.userId },
    });
    await this.audit.record(actor, { action: 'automation.create', entityType: 'automation_rule', entityId: rule.id, after: rule });
    return rule;
  }

  async update(id: string, input: z.infer<typeof RuleInput>, actor: AuthContext) {
    const v = this.validate(input);
    const before = await this.prisma.automationRule.findUniqueOrThrow({ where: { id } });
    const rule = await this.prisma.automationRule.update({
      where: { id },
      data: { name: v.name, trigger: v.kind, conditions: v.conditions as Prisma.InputJsonValue, actions: { action: v.action, notifyRole: v.notifyRole }, schedule: String(v.everyMinutes), enabled: v.enabled, requiresApproval: v.requiresApproval },
    });
    await this.audit.record(actor, { action: 'automation.update', entityType: 'automation_rule', entityId: id, before, after: rule });
    return rule;
  }

  private async evaluate(rule: AutomationRule): Promise<Match[]> {
    const c = rule.conditions as Record<string, number>;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    switch (rule.trigger as RuleKind) {
      case 'LOW_PROFIT_LISTINGS':
        return (await this.repricing.proposals()).filter((p) => p.currentMarginPercent === null || Number(p.currentMarginPercent) < (c.minMarginPercent ?? 15)).map((p) => ({ entityType: 'listing', entityId: p.listingId, summary: `${p.sku} (${p.marketplace}) ${p.reason}; proposed ${p.proposedPrice ?? 'n/a'}` }));
      case 'SUPPLIER_OUT_OF_STOCK': {
        const ls = await this.prisma.marketplaceListing.findMany({ where: { status: 'ACTIVE', product: { fulfilmentModel: 'DROPSHIP' }, variant: { supplierProducts: { some: { priority: 1, stockStatus: { in: ['OUT_OF_STOCK', 'DISCONTINUED'] } } } } }, take: 500 });
        return ls.map((l) => ({ entityType: 'listing', entityId: l.id, summary: `${l.sku} on ${l.marketplace}: supplier out of stock` }));
      }
      case 'SUPPLIER_COST_INCREASE': {
        const hist = await this.prisma.supplierPriceHistory.findMany({ where: { observedAt: { gte: hoursAgo(c.withinHours ?? 24) } }, include: { supplierProduct: { include: { variant: { select: { sku: true } } } } } });
        const out: Match[] = [];
        for (const h of hist) {
          const prev = await this.prisma.supplierPriceHistory.findFirst({ where: { supplierProductId: h.supplierProductId, observedAt: { lt: h.observedAt } }, orderBy: { observedAt: 'desc' } });
          if (prev && prev.currency === h.currency && prev.price.gt(0) && h.price.minus(prev.price).div(prev.price).times(100).gte(c.percent ?? 5)) {
            out.push({ entityType: 'variant', entityId: h.supplierProduct.variantId, summary: `${h.supplierProduct.variant.sku}: ${prev.price} → ${h.price} ${h.currency}` });
          }
        }
        return out;
      }
      case 'DISPATCH_DEADLINE': {
        const os = await this.prisma.order.findMany({ where: { status: { in: ['PAID', 'AWAITING_DISPATCH'] }, dispatchBy: { lte: new Date(Date.now() + (c.withinHours ?? 24) * 3_600_000) } }, take: 500 });
        return os.map((o) => ({ entityType: 'order', entityId: o.id, summary: `#${o.orderNumber} ${o.marketplace} due ${o.dispatchBy?.toISOString().slice(0, 16)}` }));
      }
      case 'DRAFTS_AWAITING_APPROVAL': {
        const ls = await this.prisma.marketplaceListing.findMany({ where: { status: 'AWAITING_APPROVAL', updatedAt: { lte: hoursAgo(c.olderThanHours ?? 4) } }, take: 500 });
        return ls.map((l) => ({ entityType: 'listing', entityId: l.id, summary: `${l.sku} (${l.marketplace}) waiting since ${l.updatedAt.toISOString().slice(0, 16)}` }));
      }
      case 'PUBLICATION_FAILURES': {
        const ls = await this.prisma.marketplaceListing.findMany({ where: { status: 'PUBLICATION_FAILED', updatedAt: { gte: hoursAgo(c.withinHours ?? 24) } }, take: 500 });
        return ls.map((l) => ({ entityType: 'listing', entityId: l.id, summary: `${l.sku} (${l.marketplace}): ${l.lastError ?? 'failed'}` }));
      }
      case 'STALE_SUPPLIER_DATA': {
        const sps = await this.prisma.supplierProduct.findMany({ where: { priority: 1, OR: [{ stockCheckedAt: null }, { stockCheckedAt: { lt: hoursAgo(c.olderThanHours ?? 48) } }], variant: { listings: { some: { status: 'ACTIVE' } } } }, include: { variant: { select: { sku: true } } }, take: 500 });
        return sps.map((s) => ({ entityType: 'variant', entityId: s.variantId, summary: `${s.variant.sku}: supplier stock last checked ${s.stockCheckedAt?.toISOString().slice(0, 16) ?? 'never'}` }));
      }
      case 'DAILY_SALES_REPORT': {
        const since = hoursAgo(24);
        const rows = await this.prisma.$queryRaw<Array<{ marketplace: string; orders: number; revenue: string; profit: string }>>`
          SELECT o.marketplace::text, COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(pc.net_revenue), 0)::text AS revenue, COALESCE(SUM(pc.reporting_net_profit), 0)::text AS profit
          FROM orders o JOIN order_lines ol ON ol.order_id = o.id LEFT JOIN profit_calculations pc ON pc.order_line_id = ol.id AND pc.is_current
          WHERE o.ordered_at >= ${since} GROUP BY 1 ORDER BY 1`;
        return [{ entityType: 'report', entityId: 'daily', summary: rows.length ? rows.map((r) => `${r.marketplace}: ${r.orders} orders, revenue ${Number(r.revenue).toFixed(2)}, profit ${Number(r.profit).toFixed(2)}`).join('\n') : 'No orders in the last 24 hours.' }];
      }
    }
  }

  async run(ruleId: string, manual = false) {
    const rule = await this.prisma.automationRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException();
    const run = await this.prisma.automationRun.create({ data: { ruleId, status: 'RUNNING' } });
    try {
      const matches = await this.evaluate(rule);
      const { action, notifyRole } = rule.actions as { action: string; notifyRole?: string };
      const done: string[] = [];
      if (matches.length) {
        if (action === 'PAUSE_LISTINGS' && !rule.requiresApproval && (await this.settings.get('controls.publishing_enabled'))) {
          for (const m of matches.filter((x) => x.entityType === 'listing')) {
            const l = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: m.entityId } });
            const busy = await this.prisma.listingPublicationJob.count({ where: { listingId: l.id, status: { in: ['QUEUED', 'RUNNING'] } } });
            if (busy || !l.publishedVersionId) continue;
            const job = await this.prisma.listingPublicationJob.create({ data: { listingId: l.id, versionId: l.publishedVersionId, accountId: l.accountId, operation: 'PAUSE', idempotencyKey: `${l.id}:PAUSE:${randomUUID()}`, payload: { auto: true, reason: `Automation: ${rule.name}` }, nextAttemptAt: new Date() } });
            await this.publication.dispatch(job);
            done.push(`paused ${l.sku}`);
          }
        }
        const approvalNote = action !== 'NOTIFY' && rule.requiresApproval ? '\n\nApproval required: review the listed items and act from the Listings or Repricing screens.' : '';
        await this.notifications.notify({
          type: `AUTOMATION_${rule.trigger}`,
          severity: rule.trigger === 'DAILY_SALES_REPORT' ? 'info' : 'warning',
          title: `${rule.name}: ${rule.trigger === 'DAILY_SALES_REPORT' ? 'daily summary' : `${matches.length} item(s)`}`,
          body: matches.slice(0, 20).map((m) => `• ${m.summary}`).join('\n') + (matches.length > 20 ? `\n… and ${matches.length - 20} more` : '') + approvalNote,
          entityType: 'automation_rule',
          entityId: rule.id,
          roleKey: notifyRole ?? 'owner',
        });
      }
      const summary = { matched: matches.length, actions: done, manual, sample: matches.slice(0, 50) };
      await this.prisma.$transaction([
        this.prisma.automationRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue } }),
        this.prisma.automationRule.update({ where: { id: ruleId }, data: { lastRunAt: new Date() } }),
      ]);
      return summary;
    } catch (e) {
      await this.prisma.automationRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), summary: { error: (e as Error).message } } });
      throw e;
    }
  }

  /** Called by the worker every minute: runs enabled rules whose interval has elapsed. */
  async runDue() {
    if (!(await this.settings.get('controls.automation_enabled'))) return { skipped: 'automation disabled' };
    const rules = await this.prisma.automationRule.findMany({ where: { enabled: true } });
    let ran = 0;
    for (const r of rules) {
      const every = Number(r.schedule ?? 60) * 60_000;
      if (r.lastRunAt && Date.now() - r.lastRunAt.getTime() < every) continue;
      await this.run(r.id).catch((e) => this.logger.error(`Automation ${r.name}: ${(e as Error).message}`));
      ran++;
    }
    return { ran };
  }
}
