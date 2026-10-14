import { ConflictException, Injectable } from '@nestjs/common';
import { MarketplaceCode, d } from '@fr/core';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { ProfitService } from '../finance/profit.service';
import { AccountContextService } from '../integrations/account-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ListingContent } from './listing-content';
import { ListingsService } from './listings.service';
import { PublicationService } from './publication.service';

/**
 * Workflow B/D: find live listings priced below their minimum profitable price or target margin,
 * propose a price from the reverse calculator, and apply approved changes through the marketplace API.
 */
@Injectable()
export class RepricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profit: ProfitService,
    private readonly settings: SettingsService,
    private readonly publication: PublicationService,
    private readonly listings: ListingsService,
    private readonly accounts: AccountContextService,
    private readonly audit: AuditService,
  ) {}

  async proposals(limit = 200) {
    const minMargin = await this.settings.get('alerts.min_margin_percent');
    const live = await this.prisma.marketplaceListing.findMany({ where: { status: { in: ['ACTIVE', 'PAUSED'] }, price: { not: null } }, include: { variant: { select: { sku: true } } }, take: 2000 });
    const out = [];
    for (const l of live) {
      try {
        const mp = l.marketplace as MarketplaceCode;
        const calc = await this.profit.calculate({ marketplace: mp, variantId: l.variantId, unitPrice: l.price!.toString(), quantity: 1, shippingCharged: '0', sellerDiscount: '0', fulfilmentCost: '0', advertisingCost: '0', otherExpenses: '0' });
        const margin = calc.breakdown.netMarginPercent;
        const belowMin = calc.minimumProfitablePrice && d(l.price!.toString()).lt(calc.minimumProfitablePrice);
        const lowMargin = margin !== null && margin.lt(d(minMargin));
        if (!belowMin && !lowMargin) continue;
        const target = await this.profit.reversePrice({ marketplace: mp, variantId: l.variantId, quantity: 1, shippingCharged: '0', sellerDiscount: '0', fulfilmentCost: '0', advertisingCost: '0', otherExpenses: '0', target: { kind: 'margin', percent: minMargin }, ending: '.99' });
        out.push({
          listingId: l.id, sku: l.variant.sku, marketplace: l.marketplace, currency: l.currency, currentPrice: l.price!.toString(),
          currentProfit: calc.breakdown.netProfit.toString(), currentMarginPercent: margin?.toString() ?? null,
          minimumProfitablePrice: calc.minimumProfitablePrice?.toString() ?? null,
          proposedPrice: target.achievable ? target.unitPrice!.toFixed(2) : null,
          proposedProfit: target.breakdown?.netProfit.toString() ?? null,
          reason: belowMin ? 'Below minimum profitable price' : `Margin below ${minMargin}%`,
        });
        if (out.length >= limit) break;
      } catch {
        // missing cost / FX: shown elsewhere as a data problem
      }
    }
    return out;
  }

  /** Apply an approved price to a live listing through the marketplace API (or to a draft). */
  async apply(listingId: string, price: string, actor: AuthContext, note?: string) {
    const l = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } });
    if (['ACTIVE', 'PAUSED'].includes(l.status)) {
      if (!(await this.settings.get('controls.publishing_enabled'))) throw new ConflictException({ code: 'PUBLISHING_DISABLED', message: 'Publishing is disabled by an emergency control.' });
      const job = await this.publication.enqueuePriceQuantity(listingId, { price }, note ?? 'Approved repricing', actor.userId);
      await this.audit.record(actor, { action: 'listing.reprice', entityType: 'listing', entityId: listingId, before: { price: l.price }, after: { price, note } });
      return { queued: true, jobId: job?.id };
    }
    await this.listings.updateDraft(listingId, { price }, actor);
    return { queued: false, updatedDraft: true };
  }

  /** Fetch the category's required attributes from the marketplace and store them on the draft. */
  async refreshCategoryAttributes(listingId: string, actor: AuthContext) {
    const l = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId }, include: { currentVersion: true } });
    const content = ListingContent.parse(l.currentVersion!.content);
    const category = l.marketplace === 'AMAZON_UK' ? (content as { productType?: string }).productType ?? content.categoryId : content.categoryId;
    if (!category) throw new ConflictException({ code: 'NO_CATEGORY', message: l.marketplace === 'AMAZON_UK' ? 'Set the Amazon product type first.' : 'Set the category first.' });
    const r = await this.accounts.run(l.accountId, 'FETCH_CATEGORY_ATTRIBUTES', { type: 'listing', id: listingId }, (ctx, c) => c.fetchCategoryAttributes(ctx, category));
    if (!r.ok) throw new ConflictException({ code: r.code, message: r.readable });
    await this.listings.updateDraft(listingId, { content: { requiredAttributes: r.data.required } }, actor);
    return r.data;
  }
}
