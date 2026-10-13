import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ApiZodQuery, ZodPipe, zMoneyNonNeg, zPagination } from '../common/zod';
import { zMarketplace } from '../finance/finance.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { ListingContentPatch } from './listing-content';
import { ListingsService } from './listings.service';
import { PublicationService } from './publication.service';

const ListQuery = zPagination.extend({
  status: z.enum(['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHING', 'ACTIVE', 'PUBLICATION_FAILED', 'PAUSED', 'ENDED', 'ARCHIVED']).optional(),
  marketplace: zMarketplace.optional(),
  accountId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
});
const CreateDraft = z.object({
  variantId: z.string().uuid(),
  accountId: z.string().uuid(),
  sku: z.string().max(64).optional(),
  price: zMoneyNonNeg.optional(),
  templateId: z.string().uuid().optional(),
  content: ListingContentPatch.optional(),
});
const UpdateDraft = z.object({
  content: ListingContentPatch.optional(),
  price: zMoneyNonNeg.nullable().optional(),
  sku: z.string().max(64).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
});
const Note = z.object({ note: z.string().max(2000).optional() });
const RejectBody = z.object({ note: z.string().min(1, 'Give a reason for rejecting').max(2000) });
const Ids = z.object({ listingIds: z.array(z.string().uuid()).min(1).max(1000) });
const BulkPublish = Ids.extend({ confirmToken: z.string().length(64) });
const BulkApprove = Ids.extend({ note: z.string().max(2000).optional() });
const BulkDrafts = z.object({
  variantIds: z.array(z.string().uuid()).min(1).max(500),
  accountId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  pricing: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('fixed'), price: zMoneyNonNeg }),
    z.object({ kind: z.literal('margin'), percent: zMoneyNonNeg }),
    z.object({ kind: z.literal('profit'), amount: zMoneyNonNeg }),
  ]),
});
const SyncFields = z.object({ fields: z.array(z.enum(['title', 'description', 'bulletPoints', 'attributes', 'imageIds', 'gtin', 'brand'])).min(1) });
const TemplateBody = z.object({
  name: z.string().min(1).max(80),
  marketplace: zMarketplace,
  titleTemplate: z.string().min(1).max(500),
  descriptionTemplate: z.string().max(20000),
  bulletTemplates: z.array(z.string().max(1000)).max(10).default([]),
  defaults: ListingContentPatch.default({}),
  isDefault: z.boolean().default(false),
});

@ApiTags('Listings')
@Controller('listings')
export class ListingsController {
  constructor(
    private readonly listings: ListingsService,
    private readonly publication: PublicationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermissions('listings.read')
  @ApiZodQuery(ListQuery)
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.listings.list(q);
  }

  @Get('templates')
  @RequirePermissions('listings.read')
  templates() {
    return this.prisma.listingTemplate.findMany({ orderBy: [{ marketplace: 'asc' }, { name: 'asc' }] });
  }

  @Post('templates')
  @RequirePermissions('listings.write')
  @ApiZodBody(TemplateBody)
  async createTemplate(@Body(new ZodPipe(TemplateBody)) body: z.infer<typeof TemplateBody>, @Auth() auth: AuthContext) {
    return this.prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.listingTemplate.updateMany({ where: { marketplace: body.marketplace }, data: { isDefault: false } });
      return tx.listingTemplate.create({ data: { ...body, createdById: auth.userId } });
    });
  }

  @Get(':id')
  @RequirePermissions('listings.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.listings.get(id);
  }

  @Post()
  @RequirePermissions('listings.write')
  @ApiZodBody(CreateDraft)
  create(@Body(new ZodPipe(CreateDraft)) body: z.infer<typeof CreateDraft>, @Auth() auth: AuthContext) {
    return this.listings.createDraft(body, auth);
  }

  @Post('bulk-drafts')
  @RequirePermissions('listings.write')
  @ApiZodBody(BulkDrafts)
  bulkDrafts(@Body(new ZodPipe(BulkDrafts)) body: z.infer<typeof BulkDrafts>, @Auth() auth: AuthContext) {
    return this.listings.bulkCreateDrafts(body, auth);
  }

  @Patch(':id')
  @RequirePermissions('listings.write')
  @ApiZodBody(UpdateDraft)
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateDraft)) body: z.infer<typeof UpdateDraft>, @Auth() auth: AuthContext) {
    return this.listings.updateDraft(id, body, auth);
  }

  @Post(':id/sync-from-master')
  @RequirePermissions('listings.write')
  sync(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SyncFields)) body: z.infer<typeof SyncFields>, @Auth() auth: AuthContext) {
    return this.listings.syncFromMaster(id, body.fields, auth);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @RequirePermissions('listings.write')
  validate(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.listings.validate(id, auth);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('listings.submit')
  submit(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.listings.submit(id, auth);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('listings.approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Note)) body: z.infer<typeof Note>, @Auth() auth: AuthContext) {
    return this.listings.approve(id, auth, body.note);
  }

  @Post('bulk-approve')
  @HttpCode(200)
  @RequirePermissions('listings.approve')
  async bulkApprove(@Body(new ZodPipe(BulkApprove)) body: z.infer<typeof BulkApprove>, @Auth() auth: AuthContext) {
    const results = [];
    for (const id of body.listingIds) {
      try {
        await this.listings.approve(id, auth, body.note);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: (e as Error).message });
      }
    }
    return { approved: results.filter((r) => r.ok).length, results };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('listings.approve')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>, @Auth() auth: AuthContext) {
    return this.listings.reject(id, auth, body.note);
  }

  @Post(':id/publish')
  @HttpCode(202)
  @RequirePermissions('listings.publish')
  async publish(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    const job = await this.listings.requestPublish(id, auth);
    await this.publication.dispatch(job);
    return { jobId: job.id, status: 'PUBLISHING' };
  }

  @Post(':id/retry')
  @HttpCode(202)
  @RequirePermissions('listings.publish')
  async retry(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    const job = await this.listings.requestPublish(id, auth, { retry: true });
    await this.publication.dispatch(job);
    return { jobId: job.id, status: 'PUBLISHING' };
  }

  @Post('bulk-publish/preview')
  @HttpCode(200)
  @RequirePermissions('listings.publish')
  preview(@Body(new ZodPipe(Ids)) body: z.infer<typeof Ids>) {
    return this.listings.bulkPublishPreview(body.listingIds);
  }

  @Post('bulk-publish')
  @HttpCode(202)
  @RequirePermissions('listings.publish')
  async bulkPublish(@Body(new ZodPipe(BulkPublish)) body: z.infer<typeof BulkPublish>, @Auth() auth: AuthContext) {
    const r = await this.listings.bulkPublish(body.listingIds, body.confirmToken, auth);
    for (const res of r.results) if (res.ok && res.jobId) await this.publication.dispatch({ id: res.jobId, attempts: 0 });
    return r;
  }

  @Post(':id/revise')
  @HttpCode(200)
  @RequirePermissions('listings.write')
  revise(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.listings.revise(id, auth);
  }

  @Post(':id/pause')
  @HttpCode(202)
  @RequirePermissions('listings.end')
  pause(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.stateChange(id, 'PAUSE', auth);
  }

  @Post(':id/end')
  @HttpCode(202)
  @RequirePermissions('listings.end')
  end(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.stateChange(id, 'END', auth);
  }

  @Post(':id/resume')
  @HttpCode(202)
  @RequirePermissions('listings.end')
  resume(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.stateChange(id, 'RESUME', auth);
  }

  private async stateChange(id: string, state: 'PAUSE' | 'END' | 'RESUME', auth: AuthContext) {
    const job = await this.listings.requestStateChange(id, state, auth);
    await this.publication.dispatch(job);
    return { jobId: job.id };
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('listings.write')
  archive(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.listings.archive(id, auth);
  }

  @Post('jobs/sweep')
  @HttpCode(200)
  @RequirePermissions('listings.publish')
  sweep() {
    return this.publication.sweep();
  }
}
