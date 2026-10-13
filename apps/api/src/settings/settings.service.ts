import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Typed system settings. Emergency controls pause automation without deleting data;
 * thresholds are configurable rather than hard-coded business rules.
 */
export const SETTINGS_SCHEMA = {
  'controls.publishing_enabled': z.boolean(),
  'controls.repricing_enabled': z.boolean(),
  'controls.inventory_sync_enabled': z.boolean(),
  'controls.automation_enabled': z.boolean(),
  'listings.allow_self_approval': z.boolean(),
  'alerts.min_profit': z.string().regex(/^\d+(\.\d{1,2})?$/),
  'alerts.min_margin_percent': z.string().regex(/^\d+(\.\d{1,2})?$/),
  'alerts.max_refund_rate_percent': z.string().regex(/^\d+(\.\d{1,2})?$/),
  'alerts.cost_stale_after_days': z.number().int().positive(),
  'alerts.supplier_price_increase_percent': z.string().regex(/^\d+(\.\d{1,2})?$/),
  'alerts.unexpected_fee_variance_percent': z.string().regex(/^\d+(\.\d{1,2})?$/),
  'finance.reporting_currency': z.string().regex(/^[A-Z]{3}$/),
  'finance.vat_registered': z.boolean(),
  'finance.default_vat_rate_percent': z.string().regex(/^\d+(\.\d{1,2})?$/),
  'privacy.customer_data_retention_days': z.number().int().positive(),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_SCHEMA)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  'controls.publishing_enabled': true,
  'controls.repricing_enabled': false,
  'controls.inventory_sync_enabled': false,
  'controls.automation_enabled': false,
  'listings.allow_self_approval': false,
  'alerts.min_profit': '3.00',
  'alerts.min_margin_percent': '15',
  'alerts.max_refund_rate_percent': '10',
  'alerts.cost_stale_after_days': 30,
  'alerts.supplier_price_increase_percent': '5',
  'alerts.unexpected_fee_variance_percent': '15',
  'finance.reporting_currency': 'GBP',
  'finance.vat_registered': true,
  'finance.default_vat_rate_percent': '20',
  'privacy.customer_data_retention_days': 730,
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!row) return SETTING_DEFAULTS[key];
    const parsed = SETTINGS_SCHEMA[key].safeParse(row.value);
    return (parsed.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<K>;
  }

  async all() {
    const rows = await this.prisma.systemSetting.findMany();
    const map = new Map(rows.map((r) => [r.key, r]));
    return (Object.keys(SETTINGS_SCHEMA) as SettingKey[]).map((key) => ({
      key,
      value: map.has(key) ? map.get(key)!.value : SETTING_DEFAULTS[key],
      isDefault: !map.has(key),
      updatedAt: map.get(key)?.updatedAt ?? null,
    }));
  }

  async set<K extends SettingKey>(key: K, value: unknown, actor: AuthContext | null) {
    const parsed = SETTINGS_SCHEMA[key].parse(value);
    const before = await this.get(key);
    await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: parsed as Prisma.InputJsonValue, updatedById: actor?.userId },
      create: { key, value: parsed as Prisma.InputJsonValue, updatedById: actor?.userId },
    });
    await this.audit.record(actor, { action: key.startsWith('controls.') ? 'settings.emergency_control' : 'settings.update', entityType: 'setting', entityId: key, before, after: parsed });
    return { key, value: parsed };
  }
}
