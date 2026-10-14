import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ListingStatus, MarketplaceListing, Prisma } from '@prisma/client';
import {
  ListingEvent,
  MARKETPLACES,
  MarketplaceCode,
  TransitionContext,
  ValidationResult,
  transition,
  validateListing,
} from '@fr/core';
import { createHash, randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { ProfitService } from '../finance/profit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ListingContent, ListingContentPatch, ListingContentT, TemplateVars, buildContentFromMaster } from './listing-content';

const EDITABLE: ListingStatus[] = ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLICATION_FAILED'];
const SYSTEM_ACTOR = { permissions: [] as string[], system: true };

export interface CreateDraftInput {
  variantId: string;
  accountId: string;
  sku?: string;
  price?: string;
  templateId?: string;
  content?: Partial<ListingContentT>;
}

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly profit: ProfitService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────── Queries ─────────────────────────

  async list(q: { status?: ListingStatus; marketplace?: MarketplaceCode; accountId?: string; search?: string; assignedToId?: string; page: number; pageSize: number }) {
    // Filter, sort and page in SQL (indexed search branches), then load only the page's rows.
    const conds: Prisma.Sql[] = [q.status ? Prisma.sql`l.status = ${q.status}::"ListingStatus"` : Prisma.sql`l.status <> 'ARCHIVED'`];
    if (q.marketplace) conds.push(Prisma.sql`l.marketplace = ${q.marketplace}::"Marketplace"`);
    if (q.accountId) conds.push(Prisma.sql`l.account_id = ${q.accountId}::uuid`);
    if (q.assignedToId) conds.push(Prisma.sql`l.assigned_to_id = ${q.assignedToId}::uuid`);
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(Prisma.sql`l.id IN (
        SELECT id FROM marketplace_listings WHERE sku ILIKE ${like}
        UNION SELECT id FROM marketplace_listings WHERE external_listing_id = ${q.search}
        UNION SELECT ml.id FROM marketplace_listings ml JOIN products p ON p.id = ml.product_id WHERE p.title ILIKE ${like}
        UNION SELECT ml.id FROM marketplace_listings ml JOIN product_variants v ON v.id = ml.variant_id WHERE v.sku ILIKE ${like})`);
    }
    const where = Prisma.join(conds, ' AND ');
    const [rows, count, counts] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>`SELECT l.id FROM marketplace_listings l WHERE ${where} ORDER BY l.updated_at DESC, l.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM marketplace_listings l WHERE ${where}`,
      this.prisma.marketplaceListing.groupBy({ by: ['status'], _count: true }),
    ]);
    const ids = rows.map((r) => r.id);
    const total = count[0]?.n ?? 0;
    const pos = new Map(ids.map((id, i) => [id, i]));
    const items = (
      await this.prisma.marketplaceListing.findMany({
        where: { id: { in: ids } },
        include: {
          account: { select: { name: true, environment: true } },
          variant: { select: { sku: true } },
          product: { select: { title: true, productNumber: true } },
          currentVersion: { select: { version: true, content: true, validations: { orderBy: { ranAt: 'desc' }, take: 1, select: { valid: true, blockingCount: true, ranAt: true } } } },
        },
      })
    ).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    return {
      items: items.map(({ currentVersion, ...l }) => ({
        ...l,
        title: (currentVersion?.content as ListingContentT | undefined)?.title ?? '',
        version: currentVersion?.version,
        validation: currentVersion?.validations[0] ?? null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    };
  }

  async get(id: string) {
    const l = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      include: {
        account: { select: { id: true, name: true, marketplace: true, environment: true, status: true } },
        variant: { select: { id: true, sku: true, size: true, colour: true } },
        product: { select: { id: true, title: true, productNumber: true, restricted: true, images: { orderBy: { position: 'asc' } } } },
        versions: { orderBy: { version: 'desc' }, include: { validations: { orderBy: { ranAt: 'desc' }, take: 1 } } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 100 },
        jobs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Listing not found.' });
    const operations = await this.prisma.marketplaceOperation.findMany({ where: { entityType: 'listing', entityId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    // Older, imported or adopted versions may predate newer fields: always return complete content.
    const versions = l.versions.map((v) => {
      const parsed = ListingContent.safeParse(v.content ?? {});
      return parsed.success ? { ...v, content: parsed.data } : v;
    });
    return { ...l, versions, operations };
  }

  /** Render a template against a real SKU without saving anything (template editor preview). */
  async previewTemplate(variantId: string, marketplace: MarketplaceCode, tpl: { title: string; description: string; bullets: string[] }) {
    const { v, vars, imageIds } = await this.masterVars(variantId);
    const { content, notes } = buildContentFromMaster(marketplace, vars, imageIds, { gtin: v.barcode, attributes: v.attributes as Record<string, string> }, tpl);
    return { sku: v.sku, title: content.title, description: content.description, bulletPoints: content.bulletPoints, attributes: content.attributes, notes, variables: vars };
  }

  // ───────────────────────── Draft creation & editing ─────────────────────────

  private async masterVars(variantId: string) {
    const v = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { include: { images: { where: { approved: true }, orderBy: { position: 'asc' } } } } },
    });
    if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'SKU not found.' });
    const vars: TemplateVars = {
      title: v.title ?? v.product.title,
      brand: v.product.brand,
      colour: v.colour,
      size: v.size,
      material: v.material,
      category: v.product.category,
      description: v.product.description,
      sku: v.sku,
    };
    const images = v.product.images.filter((i) => !i.variantId || i.variantId === v.id);
    return { v, vars, imageIds: images.map((i) => i.id) };
  }

  async createDraft(input: CreateDraftInput, actor: AuthContext, opts: { tx?: Tx } = {}) {
    const account = await this.prisma.marketplaceAccount.findUnique({ where: { id: input.accountId } });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Marketplace account not found.' });
    const mp = account.marketplace as MarketplaceCode;
    const { v, vars, imageIds } = await this.masterVars(input.variantId);
    const tpl = input.templateId ? await this.prisma.listingTemplate.findUnique({ where: { id: input.templateId } }) : await this.prisma.listingTemplate.findFirst({ where: { marketplace: mp, isDefault: true } });
    if (input.templateId && !tpl) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Template not found.' });
    if (tpl && tpl.marketplace !== mp) throw new BadRequestException({ code: 'TEMPLATE_MARKETPLACE', message: 'Template is for a different marketplace.' });
    const { content: base, notes } = buildContentFromMaster(
      mp,
      vars,
      imageIds,
      { gtin: v.barcode, attributes: v.attributes as Record<string, string>, defaults: (tpl?.defaults as Partial<ListingContentT>) ?? {} },
      tpl ? { title: tpl.titleTemplate, description: tpl.descriptionTemplate, bullets: tpl.bulletTemplates } : undefined,
    );
    const content = ListingContent.parse({ ...base, ...this.stripApproverFields(input.content ?? {}, actor) });

    const run = async (tx: Tx) => {
      const listing = await tx.marketplaceListing.create({
        data: {
          productId: v.productId,
          variantId: v.id,
          accountId: account.id,
          marketplace: mp,
          sku: input.sku ?? v.sku,
          currency: MARKETPLACES[mp].currency,
          price: input.price ?? null,
          status: 'INCOMPLETE',
          createdById: actor.userId,
        },
      });
      const version = await tx.listingVersion.create({ data: { listingId: listing.id, version: 1, content, createdById: actor.userId } });
      await tx.marketplaceListing.update({ where: { id: listing.id }, data: { currentVersionId: version.id } });
      await this.audit.record(actor, { action: 'listing.create_draft', entityType: 'listing', entityId: listing.id, after: { sku: listing.sku, marketplace: mp, price: input.price, notes } }, tx);
      return listing;
    };
    const listing = opts.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    const validation = await this.runValidation(listing.id, opts.tx);
    await this.applyEvent(listing.id, 'SAVE', actor, { complete: validation.complete }, 'Draft created', opts.tx);
    return { listingId: listing.id, validation, notes };
  }

  /** Only approvers may sign off compliance. */
  private stripApproverFields<T extends Partial<ListingContentT>>(patch: T, actor: AuthContext): T {
    if (patch.complianceSignedOff !== undefined && !actor.permissions.has('listings.approve')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only listing approvers can sign off compliance.' });
    }
    return patch;
  }

  async updateDraft(listingId: string, patch: { content?: Partial<ListingContentT>; price?: string | null; sku?: string; assignedToId?: string | null }, actor: AuthContext) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: listingId }, include: { currentVersion: true } });
    if (!listing) throw new NotFoundException();
    if (!EDITABLE.includes(listing.status)) {
      throw new ConflictException({ code: 'NOT_EDITABLE', message: `A ${listing.status} listing cannot be edited directly. Start a revision first.` });
    }
    if (patch.sku && listing.externalListingId) throw new ConflictException({ code: 'SKU_LOCKED', message: 'The SKU of a published listing cannot be changed.' });
    const contentPatch = ListingContentPatch.parse(this.stripApproverFields(patch.content ?? {}, actor));
    const cur = listing.currentVersion!;
    const merged = ListingContent.parse({ ...(cur.content as object), ...contentPatch });
    const needsNewVersion = listing.publishedVersionId === cur.id || cur.submittedAt !== null || cur.approvedAt !== null;

    await this.prisma.$transaction(async (tx) => {
      if (needsNewVersion) {
        const v = await tx.listingVersion.create({ data: { listingId, version: cur.version + 1, content: merged, createdById: actor.userId } });
        await tx.marketplaceListing.update({ where: { id: listingId }, data: { currentVersionId: v.id } });
      } else {
        await tx.listingVersion.update({ where: { id: cur.id }, data: { content: merged } });
      }
      await tx.marketplaceListing.update({
        where: { id: listingId },
        data: { price: patch.price === undefined ? undefined : patch.price, sku: patch.sku, assignedToId: patch.assignedToId },
      });
      await this.audit.record(actor, { action: 'listing.edit', entityType: 'listing', entityId: listingId, before: { content: cur.content, price: listing.price }, after: { content: merged, price: patch.price } }, tx);
    });
    const validation = await this.runValidation(listingId);
    // Editing invalidates any approval: SAVE moves AWAITING_APPROVAL / APPROVED back to DRAFT.
    await this.applyEvent(listingId, 'SAVE', actor, { complete: validation.complete }, 'Edited');
    return { validation, newVersion: needsNewVersion };
  }

  /** Re-pull chosen fields from the master product (shared fields are opt-in, never automatic). */
  async syncFromMaster(listingId: string, fields: Array<'title' | 'description' | 'bulletPoints' | 'attributes' | 'imageIds' | 'gtin' | 'brand'>, actor: AuthContext) {
    const listing = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } });
    const { v, vars, imageIds } = await this.masterVars(listing.variantId);
    const { content } = buildContentFromMaster(listing.marketplace as MarketplaceCode, vars, imageIds, { gtin: v.barcode, attributes: v.attributes as Record<string, string> });
    const patch: Partial<ListingContentT> = {};
    for (const f of fields) (patch as Record<string, unknown>)[f] = content[f];
    return this.updateDraft(listingId, { content: patch }, actor);
  }

  async revise(listingId: string, actor: AuthContext) {
    await this.applyEvent(listingId, 'REVISE', actor, {}, 'Revision started');
    return this.get(listingId);
  }

  // ───────────────────────── Validation ─────────────────────────

  async runValidation(listingId: string, tx?: Tx): Promise<ValidationResult> {
    const db = tx ?? this.prisma;
    const l = await db.marketplaceListing.findUniqueOrThrow({
      where: { id: listingId },
      include: { currentVersion: true, product: { select: { restricted: true, images: true } } },
    });
    const c = ListingContent.parse(l.currentVersion!.content);
    const imagesById = new Map(l.product.images.map((i) => [i.id, i]));
    const minPrice = await this.profit.minimumProfitablePrice(l.variantId, l.marketplace as MarketplaceCode, { categoryId: c.categoryId ?? undefined });
    const result = validateListing({
      marketplace: l.marketplace as MarketplaceCode,
      currency: l.currency,
      title: c.title,
      description: c.description,
      bulletPoints: c.bulletPoints,
      categoryId: c.categoryId,
      condition: c.condition,
      price: l.price?.toString() ?? null,
      quantityPolicy: c.quantityPolicy,
      images: c.imageIds.map((id, idx) => {
        const img = imagesById.get(id);
        const check = img?.checkResult as { source?: string; hasText?: boolean; hasWatermark?: boolean; hasBorderOrCollage?: boolean; backgroundIsPlainWhite?: boolean } | null | undefined;
        const analysed = check?.source === 'claude';
        return {
          url: img?.url ?? `missing:${id}`, width: img?.width ?? undefined, height: img?.height ?? undefined, format: img?.format ?? undefined, sha256: img?.sha256 ?? undefined, isMain: idx === 0,
          hasOverlayText: analysed ? !!(check!.hasText || check!.hasWatermark) : undefined,
          hasBorderOrCollage: analysed ? !!check!.hasBorderOrCollage : undefined,
          nonWhiteBackground: analysed ? check!.backgroundIsPlainWhite === false : undefined,
        };
      }),
      attributes: c.attributes,
      shippingPolicyId: c.shippingPolicyId,
      returnPolicyId: c.returnPolicyId,
      dispatchTimeDays: c.dispatchTimeDays,
      brand: c.brand,
      gtin: c.gtin,
      identifierExemption: c.identifierExemption,
      requiredAttributes: c.requiredAttributes,
      verifiedAttributes: c.verifiedAttributes,
      minimumProfitablePrice: minPrice?.toString() ?? null,
      restrictedProduct: l.product.restricted,
      complianceSignedOff: c.complianceSignedOff,
    });
    const missingImages = c.imageIds.filter((id) => !imagesById.has(id));
    if (missingImages.length) result.issues.push({ code: 'IMAGE_MISSING', field: 'images', severity: 'error', blocking: true, message: `${missingImages.length} selected image(s) no longer exist.` });
    if (minPrice === null && l.price) {
      result.issues.push({ code: 'PROFIT_UNKNOWN', field: 'price', severity: 'warning', blocking: false, message: 'Profitability could not be calculated (missing cost or exchange rate).' });
    }
    result.valid = !result.issues.some((i) => i.severity === 'error');
    result.blockingCount = result.issues.filter((i) => i.blocking).length;
    await db.listingValidationResult.create({
      data: { versionId: l.currentVersionId!, valid: result.valid, complete: result.complete, blockingCount: result.blockingCount, issues: result.issues as unknown as Prisma.InputJsonValue },
    });
    return result;
  }

  async validate(listingId: string, actor: AuthContext) {
    const result = await this.runValidation(listingId);
    const l = await this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } });
    const event: ListingEvent = result.valid && result.complete ? 'VALIDATE_PASS' : 'VALIDATE_FAIL';
    if (['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED'].includes(l.status)) {
      await this.applyEvent(listingId, event, actor, {}, `Validation ${result.valid ? 'passed' : 'failed'}`);
    }
    return result;
  }

  // ───────────────────────── Workflow ─────────────────────────

  private async transitionContext(l: MarketplaceListing & { currentVersion: { content: unknown; submittedById: string | null } | null }, actor: AuthContext, validation?: ValidationResult): Promise<TransitionContext> {
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: l.productId }, select: { restricted: true } });
    const c = ListingContent.parse(l.currentVersion?.content ?? {});
    return {
      complete: validation?.complete,
      blockingWarnings: validation?.blockingCount,
      approverIsSubmitter: l.currentVersion?.submittedById === actor.userId,
      allowSelfApproval: await this.settings.get('listings.allow_self_approval'),
      publishingDisabled: !(await this.settings.get('controls.publishing_enabled')),
      restrictedUnresolved: product.restricted && !c.complianceSignedOff,
    };
  }

  /** Apply a lifecycle event using the pure state machine, recording history and audit. */
  async applyEvent(listingId: string, event: ListingEvent, actor: AuthContext | null, ctx: TransitionContext, note?: string, txIn?: Tx, extra: Prisma.MarketplaceListingUncheckedUpdateInput = {}) {
    const run = async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM marketplace_listings WHERE id = ${listingId}::uuid FOR UPDATE`;
      const l = await tx.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } });
      const r = transition(l.status, event, actor ? { permissions: actor.permissions } : SYSTEM_ACTOR, ctx);
      await tx.marketplaceListing.update({ where: { id: listingId }, data: { ...extra, status: r.to } });
      if (r.from !== r.to || event !== 'SAVE') {
        await tx.listingStatusHistory.create({ data: { listingId, fromStatus: r.from, toStatus: r.to, event, actorId: actor?.userId, note } });
      }
      await this.audit.record(actor, { action: `listing.${event.toLowerCase()}`, entityType: 'listing', entityId: listingId, before: { status: r.from }, after: { status: r.to, note } }, tx);
      return r;
    };
    return txIn ? run(txIn) : this.prisma.$transaction(run);
  }

  private async loadForWorkflow(listingId: string) {
    const l = await this.prisma.marketplaceListing.findUnique({ where: { id: listingId }, include: { currentVersion: true, account: true } });
    if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Listing not found.' });
    return l;
  }

  async submit(listingId: string, actor: AuthContext) {
    const validation = await this.validate(listingId, actor);
    const l = await this.loadForWorkflow(listingId);
    if (!validation.valid) throw new ConflictException({ code: 'VALIDATION_FAILED', message: 'Fix validation errors before submitting.', issues: validation.issues });
    await this.prisma.$transaction(async (tx) => {
      await this.applyEvent(listingId, 'SUBMIT', actor, { complete: validation.complete }, 'Submitted for approval', tx);
      await tx.listingVersion.update({ where: { id: l.currentVersionId! }, data: { submittedById: actor.userId, submittedAt: new Date() } });
      await this.notifications.notify({ type: 'DRAFT_AWAITING_APPROVAL', title: `Listing ${l.sku} awaits approval`, entityType: 'listing', entityId: listingId, roleKey: 'listing_approver' }, tx);
    });
    return { status: 'AWAITING_APPROVAL', validation };
  }

  async approve(listingId: string, actor: AuthContext, note?: string) {
    const validation = await this.runValidation(listingId);
    const l = await this.loadForWorkflow(listingId);
    const ctx = await this.transitionContext(l, actor, validation);
    if (!validation.valid) throw new ConflictException({ code: 'VALIDATION_FAILED', message: 'Listing no longer passes validation.', issues: validation.issues });
    await this.prisma.$transaction(async (tx) => {
      await this.applyEvent(listingId, 'APPROVE', actor, ctx, note ?? 'Approved', tx);
      await tx.listingVersion.update({ where: { id: l.currentVersionId! }, data: { approvedById: actor.userId, approvedAt: new Date(), reviewNote: note } });
    });
    return { status: 'APPROVED' };
  }

  async reject(listingId: string, actor: AuthContext, note: string) {
    const l = await this.loadForWorkflow(listingId);
    await this.prisma.$transaction(async (tx) => {
      await this.applyEvent(listingId, 'REJECT', actor, {}, note, tx);
      await tx.listingVersion.update({ where: { id: l.currentVersionId! }, data: { rejectedById: actor.userId, rejectedAt: new Date(), reviewNote: note } });
      if (l.createdById) {
        await this.notifications.notify({ type: 'DRAFT_REJECTED', severity: 'warning', title: `Listing ${l.sku} was rejected`, body: note, entityType: 'listing', entityId: listingId, userId: l.createdById }, tx);
      }
    });
    return { status: 'DRAFT' };
  }

  /**
   * Compliance sign-off is part of the review: it is recorded on the version under review
   * without withdrawing the submission (unlike an edit).
   */
  async signOffCompliance(listingId: string, actor: AuthContext, note: string) {
    const l = await this.loadForWorkflow(listingId);
    if (!['AWAITING_APPROVAL', 'DRAFT', 'VALIDATION_FAILED', 'INCOMPLETE'].includes(l.status)) {
      throw new ConflictException({ code: 'NOT_UNDER_REVIEW', message: `Cannot sign off a ${l.status} listing.` });
    }
    const content = ListingContent.parse({ ...(l.currentVersion!.content as object), complianceSignedOff: true });
    await this.prisma.$transaction(async (tx) => {
      await tx.listingVersion.update({ where: { id: l.currentVersionId! }, data: { content, reviewNote: note } });
      await this.audit.record(actor, { action: 'listing.compliance_signoff', entityType: 'listing', entityId: listingId, after: { versionId: l.currentVersionId, note } }, tx);
    });
    return this.runValidation(listingId);
  }

  async archive(listingId: string, actor: AuthContext) {
    await this.applyEvent(listingId, 'ARCHIVE', actor, {}, 'Archived');
    return { status: 'ARCHIVED' };
  }

  // ───────────────────────── Publishing ─────────────────────────

  /** Create (or reuse) the publication job for the current version and move to PUBLISHING. */
  async requestPublish(listingId: string, actor: AuthContext, opts: { batchId?: string; retry?: boolean } = {}) {
    const l = await this.loadForWorkflow(listingId);
    if (l.account.status !== 'CONNECTED') {
      throw new ConflictException({
        code: 'ACCOUNT_NOT_CONNECTED',
        message: `${l.account.name} is not connected (${l.account.status}). Connect the marketplace account before publishing; the listing stays approved.`,
      });
    }
    const validation = await this.runValidation(listingId);
    if (!validation.valid) throw new ConflictException({ code: 'VALIDATION_FAILED', message: 'Listing no longer passes validation.', issues: validation.issues });
    const ctx = await this.transitionContext(l, actor, validation);
    const operation = l.externalListingId ? 'REVISE' : 'CREATE';
    const idempotencyKey = `${listingId}:${l.currentVersionId}:${operation}`;
    const job = await this.prisma.$transaction(async (tx) => {
      await this.applyEvent(listingId, opts.retry ? 'RETRY' : 'PUBLISH', actor, ctx, opts.retry ? 'Retry requested' : 'Publish requested', tx, { lastError: null });
      return tx.listingPublicationJob.upsert({
        where: { idempotencyKey },
        update: { status: 'QUEUED', nextAttemptAt: new Date(), attempts: 0, requestedById: actor.userId },
        create: { listingId, versionId: l.currentVersionId!, accountId: l.accountId, batchId: opts.batchId, operation, idempotencyKey, requestedById: actor.userId, nextAttemptAt: new Date() },
      });
    });
    return job;
  }

  /** Summarise exactly what a bulk publish will do; the confirm token pins that summary. */
  async bulkPublishPreview(listingIds: string[]) {
    const listings = await this.prisma.marketplaceListing.findMany({
      where: { id: { in: listingIds } },
      include: { account: true, currentVersion: { select: { content: true } } },
      orderBy: { id: 'asc' },
    });
    const publishingEnabled = await this.settings.get('controls.publishing_enabled');
    const items = listings.map((l) => {
      let reason: string | null = null;
      if (!publishingEnabled) reason = 'Publishing is disabled by an emergency control';
      else if (l.status !== 'APPROVED') reason = `Status is ${l.status}; only APPROVED listings can be published`;
      else if (l.account.status !== 'CONNECTED') reason = `${l.account.name} is not connected`;
      else if (!l.price) reason = 'No price set';
      return {
        id: l.id,
        sku: l.sku,
        title: (l.currentVersion?.content as ListingContentT | undefined)?.title ?? '',
        account: l.account.name,
        accountId: l.accountId,
        marketplace: l.marketplace,
        environment: l.account.environment,
        price: l.price?.toString() ?? null,
        currency: l.currency,
        versionId: l.currentVersionId,
        eligible: reason === null,
        reason,
      };
    });
    const eligible = items.filter((i) => i.eligible);
    const byAccount = Object.values(
      eligible.reduce<Record<string, { accountId: string; account: string; marketplace: string; environment: string; count: number; currency: string; totalListedValue: string }>>((acc, i) => {
        const a = (acc[i.accountId] ??= { accountId: i.accountId, account: i.account, marketplace: i.marketplace, environment: i.environment, count: 0, currency: i.currency, totalListedValue: '0' });
        a.count += 1;
        a.totalListedValue = (Number(a.totalListedValue) + Number(i.price)).toFixed(2);
        return acc;
      }, {}),
    );
    const confirmToken = createHash('sha256').update(JSON.stringify(eligible.map((i) => [i.id, i.versionId, i.price, i.accountId]))).digest('hex');
    return { total: items.length, eligibleCount: eligible.length, byAccount, items, confirmToken, missing: listingIds.filter((id) => !listings.some((l) => l.id === id)) };
  }

  async bulkPublish(listingIds: string[], confirmToken: string, actor: AuthContext) {
    const preview = await this.bulkPublishPreview(listingIds);
    if (preview.confirmToken !== confirmToken) {
      throw new ConflictException({ code: 'PREVIEW_STALE', message: 'Listings, prices or accounts changed since the preview. Review the new summary and confirm again.' });
    }
    const batchId = randomUUID();
    const results: Array<{ id: string; ok: boolean; jobId?: string; error?: string }> = [];
    for (const item of preview.items.filter((i) => i.eligible)) {
      try {
        const job = await this.requestPublish(item.id, actor, { batchId });
        results.push({ id: item.id, ok: true, jobId: job.id });
      } catch (e) {
        results.push({ id: item.id, ok: false, error: (e as Error).message });
      }
    }
    await this.audit.record(actor, { action: 'listing.bulk_publish', entityType: 'listing_batch', entityId: batchId, after: { requested: listingIds.length, queued: results.filter((r) => r.ok).length } });
    return { batchId, results };
  }

  /** Pause / end / resume a live listing. The new state is applied only after the marketplace confirms. */
  async requestStateChange(listingId: string, state: 'PAUSE' | 'END' | 'RESUME', actor: AuthContext) {
    const l = await this.loadForWorkflow(listingId);
    // Dry-run the transition with the user's permissions now; the system applies it on confirmation.
    transition(l.status, state, { permissions: actor.permissions }, { publishingDisabled: state === 'RESUME' && !(await this.settings.get('controls.publishing_enabled')) });
    if (!l.externalListingId || !l.publishedVersionId) throw new ConflictException({ code: 'NOT_LIVE', message: 'Listing is not live on the marketplace.' });
    return this.prisma.listingPublicationJob.create({
      data: {
        listingId,
        versionId: l.publishedVersionId,
        accountId: l.accountId,
        operation: state,
        idempotencyKey: `${listingId}:${state}:${randomUUID()}`,
        requestedById: actor.userId,
        nextAttemptAt: new Date(),
      },
    });
  }

  // ───────────────────────── Bulk drafts ─────────────────────────

  async bulkCreateDrafts(
    input: { variantIds: string[]; accountId: string; templateId?: string; pricing: { kind: 'none' } | { kind: 'fixed'; price: string } | { kind: 'margin'; percent: string } | { kind: 'profit'; amount: string } },
    actor: AuthContext,
  ) {
    const account = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id: input.accountId } });
    const results: Array<{ variantId: string; ok: boolean; listingId?: string; price?: string | null; error?: string; blocking?: number }> = [];
    for (const variantId of input.variantIds) {
      try {
        let price: string | undefined;
        if (input.pricing.kind === 'fixed') price = input.pricing.price;
        else if (input.pricing.kind !== 'none') {
          const r = await this.profit.reversePrice({
            marketplace: account.marketplace,
            variantId,
            quantity: 1,
            shippingCharged: '0',
            sellerDiscount: '0',
            fulfilmentCost: '0',
            advertisingCost: '0',
            otherExpenses: '0',
            target: input.pricing.kind === 'margin' ? { kind: 'margin', percent: input.pricing.percent } : { kind: 'profit', amount: input.pricing.amount },
            ending: '.99',
          });
          if (!r.achievable) throw new Error(r.message);
          price = r.unitPrice!.toFixed(2);
        }
        const d = await this.createDraft({ variantId, accountId: input.accountId, templateId: input.templateId, price }, actor);
        results.push({ variantId, ok: true, listingId: d.listingId, price: price ?? null, blocking: d.validation.blockingCount });
      } catch (e) {
        results.push({ variantId, ok: false, error: (e as Error).message });
      }
    }
    return { created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }
}
