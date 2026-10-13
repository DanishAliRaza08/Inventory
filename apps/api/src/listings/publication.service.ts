import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ListingPublicationJob } from '@prisma/client';
import type { MarketplaceCode } from '@fr/core';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { ConnectorRegistry } from '../integrations/connector-registry';
import { ConnectorResult, PublishPayload } from '../integrations/connector';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES, QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';
import { ListingContent } from './listing-content';
import { ListingsService } from './listings.service';

/** Exponential backoff with jitter, capped at 30 minutes. */
export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random * 0.4));
}

@Injectable()
export class PublicationService implements OnModuleInit {
  private readonly logger = new Logger(PublicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly registry: ConnectorRegistry,
    private readonly listings: ListingsService,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.queue.register<{ jobId: string }>(QUEUES.PUBLICATION, ({ jobId }) => this.process(jobId));
  }

  async dispatch(job: Pick<ListingPublicationJob, 'id' | 'attempts'>, delayMs?: number) {
    await this.queue.enqueue(QUEUES.PUBLICATION, { jobId: job.id }, { jobId: `${job.id}:${job.attempts}`, delayMs });
  }

  /** Re-dispatch due jobs (e.g. after publishing is re-enabled, or a worker restart). */
  async sweep() {
    if (!(await this.settings.get('controls.publishing_enabled'))) return { dispatched: 0, reason: 'publishing disabled' };
    const due = await this.prisma.listingPublicationJob.findMany({ where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } }, take: 500 });
    for (const j of due) await this.dispatch(j);
    return { dispatched: due.length };
  }

  async process(jobId: string): Promise<void> {
    // Claim the job atomically so two workers can never run it at the same time.
    const claimed = await this.prisma.listingPublicationJob.updateMany({ where: { id: jobId, status: 'QUEUED' }, data: { status: 'RUNNING', attempts: { increment: 1 } } });
    if (claimed.count === 0) return;
    const job = await this.prisma.listingPublicationJob.findUniqueOrThrow({ where: { id: jobId } });

    if (!(await this.settings.get('controls.publishing_enabled'))) {
      // Emergency stop: put the job back untouched; nothing is sent to the marketplace.
      await this.prisma.listingPublicationJob.update({ where: { id: jobId }, data: { status: 'QUEUED', attempts: { decrement: 1 }, nextAttemptAt: new Date() } });
      await this.prisma.marketplaceListing.update({ where: { id: job.listingId }, data: { lastError: 'Waiting: publishing is paused by an emergency control.' } });
      return;
    }

    const listing = await this.prisma.marketplaceListing.findUniqueOrThrow({
      where: { id: job.listingId },
      include: { account: { include: { credential: true } }, product: { select: { images: true } } },
    });
    const version = await this.prisma.listingVersion.findUniqueOrThrow({ where: { id: job.versionId } });
    const content = ListingContent.parse(version.content);
    const started = Date.now();

    let result: ConnectorResult<{ externalListingId?: string; externalOfferId?: string; status: string }>;
    try {
      const connector = this.registry.forAccount({ marketplace: listing.marketplace as MarketplaceCode, environment: listing.account.environment });
      const cred = listing.account.credential;
      const ctx = {
        accountId: listing.accountId,
        environment: listing.account.environment,
        credentials: cred ? (JSON.parse(this.crypto.decrypt(cred)) as Record<string, unknown>) : null,
        idempotencyKey: job.idempotencyKey,
      };
      const imagesById = new Map(listing.product.images.map((i) => [i.id, i]));
      const payload: PublishPayload = {
        listingId: listing.id,
        sku: listing.sku,
        price: listing.price!.toString(),
        currency: listing.currency,
        quantity: content.quantityPolicy === 'FIXED' ? content.fixedQuantity ?? 0 : listing.quantity,
        content,
        images: content.imageIds.flatMap((id, i) => (imagesById.has(id) ? [{ url: imagesById.get(id)!.url, isMain: i === 0 }] : [])),
        externalListingId: listing.externalListingId,
        externalOfferId: listing.externalOfferId,
      };
      if (job.operation === 'CREATE') result = await connector.createListing(ctx, payload);
      else if (job.operation === 'REVISE') result = await connector.reviseListing(ctx, payload);
      else {
        const state = job.operation === 'PAUSE' ? 'PAUSED' : job.operation === 'END' ? 'ENDED' : 'ACTIVE';
        result = await connector.setListingState(ctx, { externalListingId: listing.externalListingId!, state });
      }
    } catch (e) {
      result = { ok: false, transient: true, code: 'CONNECTOR_EXCEPTION', message: (e as Error).message, readable: 'The marketplace connection failed unexpectedly. The operation will be retried.' };
    }

    const failedPermanently = !result.ok && (!result.transient || job.attempts >= job.maxAttempts);
    await this.prisma.marketplaceOperation.create({
      data: {
        accountId: listing.accountId,
        operation: job.operation,
        entityType: 'listing',
        entityId: listing.id,
        jobId: job.id,
        status: result.ok ? 'SUCCEEDED' : result.code === 'CONNECTOR_NOT_IMPLEMENTED' ? 'UNSUPPORTED' : result.transient ? 'FAILED_TRANSIENT' : 'FAILED_PERMANENT',
        errorCode: result.ok ? null : result.code,
        errorMessage: result.ok ? null : result.message,
        readableError: result.ok ? null : result.readable,
        retryCount: job.attempts - 1,
        nextAction: result.ok ? null : failedPermanently ? result.nextAction ?? 'Fix the listing and retry, or revise it.' : 'Automatic retry scheduled',
        httpStatus: result.ok ? null : result.httpStatus,
        durationMs: Date.now() - started,
      },
    });

    if (result.ok) {
      await this.prisma.$transaction(async (tx) => {
        await tx.listingPublicationJob.update({ where: { id: jobId }, data: { status: 'SUCCEEDED', nextAttemptAt: null } });
        if (job.operation === 'CREATE' || job.operation === 'REVISE') {
          await this.listings.applyEvent(listing.id, 'MARKETPLACE_CONFIRMED', null, {}, `Confirmed by marketplace`, tx, {
            externalListingId: result.data.externalListingId ?? listing.externalListingId,
            externalOfferId: result.data.externalOfferId ?? listing.externalOfferId,
            publishedVersionId: job.versionId,
            lastPublishedAt: new Date(),
            lastError: null,
            autoPaused: false,
          });
        } else {
          const event = job.operation === 'PAUSE' ? 'PAUSE' : job.operation === 'END' ? 'END' : 'RESUME';
          await this.listings.applyEvent(listing.id, event, null, {}, 'Confirmed by marketplace', tx, { lastError: null });
        }
      });
      return;
    }

    if (!failedPermanently) {
      const delay = backoffMs(job.attempts);
      await this.prisma.listingPublicationJob.update({ where: { id: jobId }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + delay) } });
      await this.prisma.marketplaceListing.update({ where: { id: listing.id }, data: { lastError: `${result.readable} (attempt ${job.attempts} of ${job.maxAttempts})` } });
      await this.dispatch({ id: jobId, attempts: job.attempts }, delay);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.listingPublicationJob.update({ where: { id: jobId }, data: { status: 'FAILED', nextAttemptAt: null } });
      if (job.operation === 'CREATE' || job.operation === 'REVISE') {
        await this.listings.applyEvent(listing.id, 'MARKETPLACE_FAILED', null, {}, result.ok ? undefined : result.readable, tx, { lastError: result.ok ? null : result.readable });
      } else {
        await tx.marketplaceListing.update({ where: { id: listing.id }, data: { lastError: result.ok ? null : result.readable } });
      }
      await this.notifications.notify(
        { type: 'LISTING_PUBLICATION_FAILED', severity: 'warning', title: `${job.operation} failed for ${listing.sku}`, body: result.ok ? '' : result.readable, entityType: 'listing', entityId: listing.id, roleKey: 'owner' },
        tx,
      );
    });
    this.logger.warn(`Publication job ${jobId} failed: ${result.ok ? '' : result.code}`);
  }
}
