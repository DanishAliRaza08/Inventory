import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IMPORT_FIELD_KEYS } from '@fr/core';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { ImportsService } from './imports.service';
import { writeTable } from './tabular';

const MappingBody = z.object({ mapping: z.record(z.enum(IMPORT_FIELD_KEYS as [string, ...string[]]), z.string()) });
const Format = z.enum(['csv', 'xlsx']).default('csv');

function send(res: Response, buf: Buffer, name: string, format: 'csv' | 'xlsx') {
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
  res.send(buf);
}

@ApiTags('Imports & exports')
@Controller()
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('imports/template')
  async template(@Query('format') format: string | undefined, @Res() res: Response) {
    const f = Format.parse(format);
    send(res, await this.imports.template(f), 'fashion-rockstar-product-import-template', f);
  }

  @Get('imports')
  @RequirePermissions('imports.run')
  list() {
    return this.imports.list();
  }

  @Post('imports')
  @RequirePermissions('imports.run')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Auth() auth: AuthContext) {
    if (!file) throw new BadRequestException({ code: 'NO_FILE', message: 'Attach a CSV or XLSX file as "file".' });
    return this.imports.upload(file.originalname, file.buffer, auth);
  }

  @Get('imports/:id')
  @RequirePermissions('imports.run')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(id);
  }

  @Post('imports/:id/validate')
  @RequirePermissions('imports.run')
  validate(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MappingBody)) body: z.infer<typeof MappingBody>, @Auth() auth: AuthContext) {
    return this.imports.validate(id, body.mapping, auth);
  }

  @Post('imports/:id/commit')
  @RequirePermissions('imports.run', 'products.write')
  commit(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.imports.commit(id, auth);
  }

  @Get('imports/:id/errors')
  @RequirePermissions('imports.run')
  async errors(@Param('id', ParseUUIDPipe) id: string, @Query('format') format: string | undefined, @Res() res: Response) {
    const f = Format.parse(format);
    send(res, await this.imports.errorReport(id, f), `import-${id.slice(0, 8)}-errors`, f);
  }

  // ── Exports ──
  @Get('exports/products')
  @RequirePermissions('exports.run', 'products.read')
  async exportProducts(@Query('format') format: string | undefined, @Res() res: Response) {
    const f = Format.parse(format);
    const variants = await this.prisma.productVariant.findMany({
      include: {
        product: true,
        inventory: { where: { location: 'MAIN' } },
        supplierProducts: { where: { priority: 1 }, include: { supplier: true }, take: 1 },
        costRecords: { where: { effectiveTo: null }, take: 1 },
        listings: { where: { status: { not: 'ARCHIVED' } } },
      },
      orderBy: { sku: 'asc' },
    });
    const rows: Array<Record<string, unknown>> = [];
    for (const v of variants) {
      const sp = v.supplierProducts[0];
      const c = v.costRecords[0];
      const base = {
        product_id: `FRP-${String(v.product.productNumber).padStart(6, '0')}`,
        parent_sku: '', sku: v.sku, title: v.title ?? v.product.title, description: v.product.description, category: v.product.category ?? '', brand: v.product.brand ?? '',
        barcode: v.barcode ?? '', size: v.size ?? '', colour: v.colour ?? '', material: v.material ?? '', weight_g: v.weightGrams ?? '',
        supplier: sp?.supplier.name ?? '', supplier_url: sp?.url ?? '', supplier_sku: sp?.supplierSku ?? '', supplier_product_id: sp?.supplierProductId ?? '',
        cost: c?.supplierPrice.toFixed(2) ?? '', supplier_shipping: c?.supplierShipping.toFixed(2) ?? '', packaging: c?.packaging.toFixed(2) ?? '', currency: c?.currency ?? '',
        fulfilment_model: v.product.fulfilmentModel,
        stock: v.product.fulfilmentModel === 'PHYSICAL' ? v.inventory[0]?.available ?? 0 : sp?.reportedQuantity ?? '',
        safety_stock: v.inventory[0]?.safetyStock ?? '', selling_price: '', marketplace: '', marketplace_sku: '',
      };
      rows.push(base);
      for (const l of v.listings) rows.push({ ...base, selling_price: l.price?.toFixed(2) ?? '', marketplace: l.marketplace, marketplace_sku: l.sku === v.sku ? '' : l.sku });
    }
    const { IMPORT_TEMPLATE_HEADERS } = await import('@fr/core');
    send(res, await writeTable(f, IMPORT_TEMPLATE_HEADERS, rows, 'Products'), `products-${new Date().toISOString().slice(0, 10)}`, f);
  }

  @Get('exports/listings')
  @RequirePermissions('exports.run', 'listings.read')
  async exportListings(@Query('format') format: string | undefined, @Res() res: Response) {
    const f = Format.parse(format);
    const listings = await this.prisma.marketplaceListing.findMany({ include: { account: true, variant: true, currentVersion: true }, orderBy: { updatedAt: 'desc' } });
    const headers = ['listing_id', 'marketplace', 'account', 'master_sku', 'marketplace_sku', 'external_listing_id', 'status', 'title', 'price', 'currency', 'quantity', 'last_error', 'updated_at'];
    const rows = listings.map((l) => ({
      listing_id: l.id, marketplace: l.marketplace, account: l.account.name, master_sku: l.variant.sku, marketplace_sku: l.sku, external_listing_id: l.externalListingId ?? '',
      status: l.status, title: (l.currentVersion?.content as { title?: string })?.title ?? '', price: l.price?.toFixed(2) ?? '', currency: l.currency, quantity: l.quantity,
      last_error: l.lastError ?? '', updated_at: l.updatedAt.toISOString(),
    }));
    send(res, await writeTable(f, headers, rows, 'Listings'), `listings-${new Date().toISOString().slice(0, 10)}`, f);
  }

  @Get('exports/costs')
  @RequirePermissions('exports.run', 'costs.read')
  async exportCosts(@Query('format') format: string | undefined, @Res() res: Response) {
    const f = Format.parse(format);
    const costs = await this.prisma.costRecord.findMany({ include: { variant: { select: { sku: true } } }, orderBy: [{ variantId: 'asc' }, { effectiveFrom: 'asc' }] });
    const headers = ['sku', 'effective_from', 'effective_to', 'currency', 'supplier_price', 'supplier_shipping', 'packaging', 'import_duty', 'non_recoverable_tax', 'fx_conversion_percent', 'purchase_payment_percent', 'other_per_unit', 'source', 'verified_at'];
    const rows = costs.map((c) => ({
      sku: c.variant.sku, effective_from: c.effectiveFrom.toISOString(), effective_to: c.effectiveTo?.toISOString() ?? '', currency: c.currency,
      supplier_price: c.supplierPrice.toString(), supplier_shipping: c.supplierShipping.toString(), packaging: c.packaging.toString(), import_duty: c.importDuty.toString(),
      non_recoverable_tax: c.nonRecoverableTax.toString(), fx_conversion_percent: c.fxConversionPercent.toString(), purchase_payment_percent: c.purchasePaymentPercent.toString(),
      other_per_unit: c.otherPerUnit.toString(), source: c.source, verified_at: c.verifiedAt?.toISOString() ?? '',
    }));
    send(res, await writeTable(f, headers, rows, 'Cost history'), `cost-history-${new Date().toISOString().slice(0, 10)}`, f);
  }
}
