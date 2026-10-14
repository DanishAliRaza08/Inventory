import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ApiZodQuery, ZodPipe, zMoneyNonNeg, zPagination } from '../common/zod';
import { zMarketplace } from '../finance/finance.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { SupplierSyncService } from '../suppliers/supplier-sync.service';
import { OrdersService } from './orders.service';

const ListQ = zPagination.extend({
  marketplace: zMarketplace.optional(),
  status: z.string().optional(),
  supplierId: z.string().uuid().optional(),
  sku: z.string().max(64).optional(),
  search: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  dueWithinHours: z.coerce.number().int().positive().optional(),
});
const Shipment = z.object({ carrier: z.string().min(1).max(60), trackingNumber: z.string().min(3).max(80), shippedAt: z.coerce.date().optional(), labelCost: zMoneyNonNeg.optional() });
const Refund = z.object({ amount: zMoneyNonNeg, taxAmount: zMoneyNonNeg.optional(), orderLineId: z.string().uuid().optional(), reason: z.string().max(500).optional() });
const ReturnIn = z.object({ orderLineId: z.string().uuid().optional(), reason: z.string().max(500).optional(), returnShippingCost: zMoneyNonNeg.optional() });
const Receive = z.object({ restockable: z.boolean(), returnShippingCost: zMoneyNonNeg.optional() });
const ManualSupplier = z.object({ supplierId: z.string().uuid(), externalOrderId: z.string().min(1).max(80) });
const Delivered = z.object({ deliveredAt: z.coerce.date().default(() => new Date()) });

@ApiTags('Orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly supplierSync: SupplierSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('orders')
  @RequirePermissions('orders.read')
  @ApiZodQuery(ListQ)
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    return this.orders.list(q);
  }

  @Get('orders/:id')
  @RequirePermissions('orders.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }

  @Post('orders/:id/shipments')
  @RequirePermissions('orders.manage')
  @ApiZodBody(Shipment)
  ship(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Shipment)) body: z.infer<typeof Shipment>, @Auth() auth: AuthContext) {
    return this.orders.recordShipment(id, body, auth);
  }

  @Post('orders/:id/delivered')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  delivered(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Delivered)) body: z.infer<typeof Delivered>, @Auth() auth: AuthContext) {
    return this.orders.markDelivered(id, body.deliveredAt, auth);
  }

  @Post('orders/:id/supplier-order')
  @HttpCode(200)
  @RequirePermissions('orders.manage', 'orders.customer_pii')
  placeSupplierOrder(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.supplierSync.placeOrder(id, auth);
  }

  @Post('orders/:id/supplier-order/manual')
  @RequirePermissions('orders.manage')
  manualSupplierOrder(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ManualSupplier)) body: z.infer<typeof ManualSupplier>, @Auth() auth: AuthContext) {
    return this.supplierSync.recordManualOrder(id, body, auth);
  }

  @Post('orders/:id/refunds')
  @RequirePermissions('returns.manage')
  refund(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Refund)) body: z.infer<typeof Refund>, @Auth() auth: AuthContext) {
    return this.orders.recordRefund(id, body, auth);
  }

  @Post('orders/:id/returns')
  @RequirePermissions('returns.manage')
  createReturn(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReturnIn)) body: z.infer<typeof ReturnIn>, @Auth() auth: AuthContext) {
    return this.orders.createReturn(id, body, auth);
  }

  @Post('returns/:id/receive')
  @HttpCode(200)
  @RequirePermissions('returns.manage')
  receive(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Receive)) body: z.infer<typeof Receive>, @Auth() auth: AuthContext) {
    return this.orders.receiveReturn(id, body, auth);
  }

  @Get('returns')
  @RequirePermissions('orders.read')
  returns(@Query('status') status?: string) {
    return this.prisma.return.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 300, include: { order: { select: { id: true, orderNumber: true, externalOrderId: true, marketplace: true } } } });
  }

  @Get('refunds')
  @RequirePermissions('orders.read')
  refunds() {
    return this.prisma.refund.findMany({ orderBy: { refundedAt: 'desc' }, take: 300, include: { order: { select: { id: true, orderNumber: true, externalOrderId: true, marketplace: true } } } });
  }

  @Post('orders/:id/recalculate')
  @HttpCode(200)
  @RequirePermissions('finance.reconcile')
  async recalc(@Param('id', ParseUUIDPipe) id: string) {
    await this.orders.recalculateProfit(id);
    return this.orders.get(id);
  }
}
