import { Injectable, Logger } from '@nestjs/common';
import { planInventorySync } from '@fr/core';
import { randomUUID } from 'crypto';
import { PublicationService } from '../listings/publication.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { InventoryService } from './inventory.service';

/**
 * Pushes available-to-sell quantities to live listings according to each SKU's policy
 * (manual, monitor-only, auto-sync, auto-pause). Never resumes a listing a person paused;
 * honours the emergency control and the relist-approval setting.
 */
@Injectable()
export class InventorySyncService {
  private readonly logger = new Logger(InventorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly publication: PublicationService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  async syncVariant(variantId: string) {
    const syncDisabled = !(await this.settings.get('controls.inventory_sync_enabled'));
    const availability = await this.inventory.availability(variantId);
    const rec = availability.record;
    const listings = await this.prisma.marketplaceListing.findMany({ where: { variantId, status: { in: ['ACTIVE', 'PAUSED'] }, externalListingId: { not: null } } });
    if (!listings.length) return { actions: [] };
    const plan = planInventorySync({
      policy: rec.policy,
      availableToSell: availability.availableToSell,
      mode: rec.allocationMode,
      requireRelistApproval: rec.requireRelistApproval,
      syncDisabled,
      listings: listings.map((l) => ({ listingId: l.id, status: l.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED', currentQuantity: l.quantity, allocation: l.allocation ?? undefined, autoPaused: l.autoPaused })),
    });
    // Skip listings that already have state-changing work in flight.
    const busy = new Set((await this.prisma.listingPublicationJob.findMany({ where: { listingId: { in: listings.map((l) => l.id) }, status: { in: ['QUEUED', 'RUNNING'] }, operation: { in: ['PAUSE', 'RESUME', 'END', 'UPDATE_PRICE_QUANTITY'] } } })).map((j) => j.listingId));
    for (const a of plan) {
      if (busy.has(a.listingId)) continue;
      const l = listings.find((x) => x.id === a.listingId)!;
      if (a.action === 'UPDATE_QUANTITY') await this.publication.enqueuePriceQuantity(l.id, { quantity: a.targetQuantity }, a.reason);
      else if (a.action === 'PAUSE' || a.action === 'RESUME') {
        if (a.action === 'RESUME') await this.prisma.marketplaceListing.update({ where: { id: l.id }, data: { quantity: a.targetQuantity } });
        const job = await this.prisma.listingPublicationJob.create({
          data: { listingId: l.id, versionId: l.publishedVersionId!, accountId: l.accountId, operation: a.action, idempotencyKey: `${l.id}:${a.action}:${randomUUID()}`, payload: { auto: true, reason: a.reason }, nextAttemptAt: new Date() },
        });
        await this.publication.dispatch(job);
      } else if (a.action === 'NEEDS_RELIST_APPROVAL' || a.action === 'ALERT_ONLY') {
        await this.notifications.notify({ type: a.action, severity: 'info', title: `${l.sku}: ${a.reason}`, entityType: 'listing', entityId: l.id, roleKey: 'inventory_manager' });
      }
    }
    return { availableToSell: availability.availableToSell, actions: plan };
  }

  async syncAll() {
    if (!(await this.settings.get('controls.inventory_sync_enabled'))) return { skipped: 'disabled' };
    const records = await this.prisma.inventoryRecord.findMany({
      where: { policy: { in: ['AUTO_SYNC', 'AUTO_PAUSE', 'SUPPLIER_MONITOR'] }, variant: { listings: { some: { status: { in: ['ACTIVE', 'PAUSED'] } } } } },
      select: { variantId: true },
    });
    for (const r of records) await this.syncVariant(r.variantId).catch((e) => this.logger.error(`Inventory sync ${r.variantId}: ${(e as Error).message}`));
    return { variants: records.length };
  }
}
