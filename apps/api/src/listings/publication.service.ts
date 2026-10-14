import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ListingPublicationJob, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AccountContextService } from '../integrations/account-context.service';
import { ConnectorResult, PublishPayload } from '../integrations/connector';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES, QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';
import { ImageUrlService } from '../storage/image-url.service';
import { ListingContent } from './listing-content';
import { ListingsService } from './listings.service';

/** Exponential backoff with jitter, capped at 30 minutes. */
export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random * 0.4));
}

/** Delay between "is it live yet?" checks for marketplaces that review listings (Amazon, TikTok). */
const CONFIRM_DELAY_MS = 5 * 60_000;
const CONFIRM_MAX_CHECKS = 300; // ~25 hours

@Injectable()
export class PublicationService implements OnModuleInit {
  private readonly logger = new Logger(PublicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly accounts: AccountContextService,
    private readonly listings: ListingsService,
    private readonly settings: SettingsService,
    private readonly imageUrls: ImageUrlService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.queue.register<{ jobId: string }>(QUEUES.PUBLICATION, ({ jobId }) => this.process(jobId));
  }

  async dispatch(job: Pick<ListingPublicationJob, 'id' | 'attempts'>, delayMs?: number) {
    await this.queue.enqueue(QUEUES.PUBLICATION, { jobId: job.id }, { jobId: `${job.id}:${job.attempts}:${Date.now()}`, delayMs });
  }

  /** Re-dispatch due jobs (after publishing is re-enabled, worker restarts, confirmation polling). */
  async sweep() {
    if (!(await this.settings.get('controls.publishing_enabled'))) return { dispatched: 0, reason: 'publishing disabled' };
    const due = await this.prisma.listingPublicationJob.findMany({ where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } }, take: 500 });
    for (const j of due) await this.dispatch(j);
    return { dispatched: due.length };
  }

  /** Queue a price/quantity update for a live listing (used by inventory sync and repricing). */
  async enqueuePriceQuantity(listingId: string, change: { price?: string; quantity?: number }, reason: string, requestedById?: string) {
    const l = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } });
    if (!l.externalListingId || !l.publishedVersionId) return null;
    const job = await this.prisma.listingPublicationJob.create({
      data: {
        listingId,
        versionId: l.publishedVersionId,
        accountId: l.accountId,
        operation: 'UPDATE_PRICE_QUANTITY',
        idempotencyKey: `${listingId}:PQ:${randomUUID()}`,
        payload: { ...change, reason } as Prisma.InputJsonValue,
        requestedById,
        nextAttemptAt: new Date(),
      },
    });
    await this.dispatch(job);
    return job;
  }

  private async payload(listingId: string, versionId: string): Promise<PublishPayload> {
    const listing = await this.prisma.marketplaceListing.findUniqueOrThrow({
      where: { id: listingId },
      include: { account: true, product: { select: { images: true } }, variant: true },
    });
    const version = await this.prisma.listingVersion.findUniqueOrThrow({ where: { id: versionId } });
    const content = ListingContent.parse(version.content);
    const imagesById = new Map(listing.product.images.map((i) => [i.id, i]));
    return {
      listingId: listing.id,
      sku: listing.sku,
      price: listing.price!.toString(),
      currency: listing.currency,
      quantity: content.quantityPolicy === 'FIXED' ? content.fixedQuantity ?? 0 : Math.max(listing.quantity, content.quantityPolicy === 'SYNC' ? 0 : 1),
      content,
      images: content.imageIds.flatMap((id, i) => (imagesById.has(id) ? [{ url: this.imageUrls.sign(id), isMain: i === 0 }] : [])),
      externalListingId: listing.externalListingId,
      externalOfferId: listing.externalOfferId,
      accountSettings: (listing.account.settings as Record<string, unknown>) ?? {},
      variant: { sku: listing.variant.sku, size: listing.variant.size, colour: listing.variant.colour, weightGrams: listing.variant.weightGrams },
    };
  }

  async process(jobId: string): Promise<void> {
    // Claim the job atomically so two workers never run it at the same time.
    const claimed = await this.prisma.listingPublicationJob.updateMany({ where: { id: jobId, status: 'QUEUED' }, data: { status: 'RUNNING', attempts: { increment: 1 } } });
    if (claimed.count === 0) return;
    const job = await this.prisma.listingPublicationJob.findUniqueOrThrow({ where: { id: jobId } });

    if (!(await this.settings.get('controls.publishing_enabled'))) {
      await this.prisma.listingPublicationJob.update({ where: { id: jobId }, data: { status: 'QUEUED', attempts: { decrement: 1 }, nextAttemptAt: new Date() } });
      await this.prisma.marketplaceListing.update({ where: { id: job.listingId }, data: { lastError: 'Waiting: publishing is paused by an emergency control.' } });
      return;
    }
    const listing = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: job.listingId } });

    if (job.operation === 'CONFIRM') return this.confirm(job, listing.externalListingId!, listing.sku);

    const result = await this.accounts.run<unknown>(
      job.accountId,
      job.operation,
      { type: 'listing', id: listing.id, jobId: job.id, retryCount: job.attempts - 1 },
      async (ctx, connector): Promise<ConnectorResult<unknown>> => {
        switch (job.operation) {
          case 'CREATE':
            return connector.createListing(ctx, await this.payload(listing.id, job.versionId));
          case 'REVISE':
            return connector.reviseListing(ctx, await this.payload(listing.id, job.versionId));
          case 'UPDATE_PRICE_QUANTITY': {
            const pl = (job.payload ?? {}) as { price?: string; quantity?: number };
            return connector.updatePriceQuantity(ctx, { externalListingId: listing.externalListingId!, externalOfferId: listing.externalOfferId, sku: listing.sku, currency: listing.currency, ...pl });
          }
          default: {
            const state = job.operation === 'PAUSE' ? 'PAUSED' : job.operation === 'END' ? 'ENDED' : 'ACTIVE';
            return connector.setListingState(ctx, { externalListingId: listing.externalListingId!, externalOfferId: listing.externalOfferId, sku: listing.sku, state, quantity: listing.quantity || 1 });
          }
        }
      },
      job.idempotencyKey,
    );

    if (result.ok) return this.onSuccess(job, result.data as Record<string, any>);
    const permanent = !result.transient || job.attempts >= job.maxAttempts;
    if (!permanent) {
      const delay = backoffMs(job.attempts);
      await this.prisma.listingPublicationJob.update({ where: { id: jobId }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + delay), lastError: result.readable } });
      await this.prisma.marketplaceListing.update({ where: { id: listing.id }, data: { lastError: `${result.readable} (attempt ${job.attempts} of ${job.maxAttempts})` } });
      await this.dispatch({ id: jobId, attempts: job.attempts }, delay);
      return;
    }
    await this.fail(job, result.readable);
  }

  private async onSuccess(job: ListingPublicationJob, data: Record<string, any>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.listingPublicationJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', nextAttemptAt: null, lastError: null } });
      if (job.operation === 'CREATE' || job.operation === 'REVISE') {
        const listing = await tx.marketplaceListing.findUniqueOrThrow({ where: { id: job.listingId } });
        if (data.status === 'PENDING') {
          // Accepted but under marketplace review: remember the ids, keep PUBLISHING, poll for the outcome.
          await tx.marketplaceListing.update({
            where: { id: job.listingId },
            data: { externalListingId: data.externalListingId ?? listing.externalListingId, externalOfferId: data.externalOfferId || listing.externalOfferId, lastError: 'Submitted — waiting for the marketplace to approve the listing.' },
          });
          await tx.listingPublicationJob.upsert({
            where: { idempotencyKey: `${job.listingId}:${job.versionId}:CONFIRM` },
            update: { status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(Date.now() + CONFIRM_DELAY_MS) },
            create: {
              listingId: job.listingId, versionId: job.versionId, accountId: job.accountId, operation: 'CONFIRM', maxAttempts: CONFIRM_MAX_CHECKS,
              idempotencyKey: `${job.listingId}:${job.versionId}:CONFIRM`, nextAttemptAt: new Date(Date.now() + CONFIRM_DELAY_MS), batchId: job.batchId,
            },
          });
          return;
        }
        await this.listings.applyEvent(job.listingId, 'MARKETPLACE_CONFIRMED', null, {}, 'Confirmed by marketplace', tx, {
          externalListingId: data.externalListingId ?? listing.externalListingId,
          externalOfferId: data.externalOfferId ?? listing.externalOfferId,
          publishedVersionId: job.versionId,
          lastPublishedAt: new Date(),
          lastError: null,
          autoPaused: false,
        });
      } else if (job.operation === 'UPDATE_PRICE_QUANTITY') {
        const pl = (job.payload ?? {}) as { price?: string; quantity?: number };
        await tx.marketplaceListing.update({ where: { id: job.listingId }, data: { price: pl.price ?? undefined, quantity: pl.quantity ?? undefined, lastError: null } });
      } else {
        const event = job.operation === 'PAUSE' ? 'PAUSE' : job.operation === 'END' ? 'END' : 'RESUME';
        const pl = (job.payload ?? {}) as { auto?: boolean };
        await this.listings.applyEvent(job.listingId, event, null, {}, pl.auto ? 'Automatic (stock)' : 'Confirmed by marketplace', tx, { lastError: null, autoPaused: event === 'PAUSE' ? !!pl.auto : false });
      }
    });
  }

  private async confirm(job: ListingPublicationJob, externalListingId: string, sku: string) {
    const r = await this.accounts.run(job.accountId, 'GET_LISTING_STATUS', { type: 'listing', id: job.listingId, jobId: job.id }, (ctx, c) => c.getListingStatus(ctx, { externalListingId, sku }));
    const requeue = async (msg: string) => {
      await this.prisma.listingPublicationJob.update({ where: { id: job.id }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + CONFIRM_DELAY_MS), lastError: msg } });
      await this.dispatch(job, CONFIRM_DELAY_MS);
    };
    if (!r.ok) {
      if (r.transient && job.attempts < job.maxAttempts) return requeue(r.readable);
      return this.fail(job, r.readable);
    }
    if (r.data.state === 'ACTIVE' || r.data.state === 'PAUSED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.listingPublicationJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', nextAttemptAt: null } });
        await this.listings.applyEvent(job.listingId, 'MARKETPLACE_CONFIRMED', null, {}, 'Approved and live on the marketplace', tx, {
          publishedVersionId: job.versionId,
          lastPublishedAt: new Date(),
          lastError: null,
        });
      });
      return;
    }
    if (r.data.state === 'FAILED') return this.fail(job, `The marketplace did not approve the listing: ${r.data.reason ?? 'no reason given'}`);
    if (job.attempts >= job.maxAttempts) return this.fail(job, 'The marketplace has not approved the listing after 25 hours. Check it in the seller centre, then retry.');
    return requeue(r.data.reason ?? 'Still under marketplace review');
  }

  private async fail(job: ListingPublicationJob, readable: string) {
    const listing = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: job.listingId } });
    await this.prisma.$transaction(async (tx) => {
      await tx.listingPublicationJob.update({ where: { id: job.id }, data: { status: 'FAILED', nextAttemptAt: null, lastError: readable } });
      if (['CREATE', 'REVISE', 'CONFIRM'].includes(job.operation) && listing.status === 'PUBLISHING') {
        await this.listings.applyEvent(listing.id, 'MARKETPLACE_FAILED', null, {}, readable, tx, { lastError: readable });
      } else {
        await tx.marketplaceListing.update({ where: { id: listing.id }, data: { lastError: readable } });
      }
      await this.notifications.notify(
        { type: 'LISTING_PUBLICATION_FAILED', severity: 'warning', title: `${job.operation.toLowerCase().replace(/_/g, ' ')} failed for ${listing.sku}`, body: readable, entityType: 'listing', entityId: listing.id, roleKey: 'owner' },
        tx,
      );
    });
    this.logger.warn(`Publication job ${job.id} (${job.operation}) failed: ${readable}`);
  }
}
