import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Supplier } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { CryptoService } from '../common/crypto.service';
import { ApiCallError } from '../integrations/http';
import { aliexpressExchangeCode, aliexpressPlaceOrder, aliexpressPriceStock, aliexpressTracking } from '../integrations/suppliers/aliexpress';
import { cjAccessToken, cjPlaceOrder, cjPriceStock, cjTracking } from '../integrations/suppliers/cj';
import { InventorySyncService } from '../inventory/inventory-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerPiiService } from '../privacy/customer-pii.service';
import { SuppliersService } from './suppliers.service';

@Injectable()
export class SupplierSyncService {
  private readonly logger = new Logger(SupplierSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly suppliers: SuppliersService,
    private readonly inventorySync: InventorySyncService,
    private readonly orders: OrdersService,
    private readonly pii: CustomerPiiService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private async save(supplierId: string, creds: Record<string, unknown>) {
    const enc = this.crypto.encrypt(JSON.stringify(creds));
    const expiresAt = typeof creds.accessTokenExpiresAt === 'string' ? new Date(creds.accessTokenExpiresAt) : null;
    await this.prisma.supplierConnection.upsert({
      where: { supplierId },
      update: { ...enc, status: 'CONNECTED', expiresAt, lastError: null },
      create: { supplierId, ...enc, status: 'CONNECTED', expiresAt },
    });
  }

  async connectAliExpress(supplierId: string, code: string) {
    await this.save(supplierId, await aliexpressExchangeCode(code));
  }

  async connectCj(supplierId: string, actor: AuthContext) {
    const s = await this.prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    if (s.type !== 'CJ_DROPSHIPPING') throw new BadRequestException({ code: 'WRONG_TYPE', message: 'This supplier is not CJ Dropshipping.' });
    await this.save(supplierId, await cjAccessToken());
    await this.audit.record(actor, { action: 'supplier.connect', entityType: 'supplier', entityId: supplierId });
  }

  /** Valid access token for a supplier (refreshing CJ tokens automatically). */
  private async token(supplier: Supplier): Promise<string> {
    const conn = await this.prisma.supplierConnection.findUnique({ where: { supplierId: supplier.id } });
    if (!conn?.ciphertext) throw new ApiCallError('Supplier not connected', { transient: false, code: 'NOT_CONNECTED', readable: `${supplier.name} is not connected to its API.` });
    const creds = JSON.parse(this.crypto.decrypt({ ciphertext: conn.ciphertext, iv: conn.iv!, authTag: conn.authTag! }));
    if (conn.expiresAt && conn.expiresAt.getTime() < Date.now() + 60_000) {
      if (supplier.type === 'CJ_DROPSHIPPING') {
        const fresh = await cjAccessToken();
        await this.save(supplier.id, fresh);
        return fresh.accessToken;
      }
      await this.prisma.supplierConnection.update({ where: { supplierId: supplier.id }, data: { status: 'EXPIRED' } });
      throw new ApiCallError('AliExpress token expired', { transient: false, authExpired: true, code: 'AUTH_EXPIRED', readable: 'The AliExpress authorisation expired. Reconnect it on the supplier page.' });
    }
    return creds.accessToken;
  }

  /** Pull current price, stock and ships-from for one supplier SKU, through the normal history/cost paths. */
  async syncSupplierProduct(supplierProductId: string) {
    const sp = await this.prisma.supplierProduct.findUnique({ where: { id: supplierProductId }, include: { supplier: true } });
    if (!sp) throw new NotFoundException();
    const ref = sp.supplier.type === 'CJ_DROPSHIPPING' ? sp.supplierSku ?? sp.supplierProductId : sp.supplierProductId;
    if (!ref || sp.supplier.type === 'MANUAL' || sp.supplier.type === 'OTHER') return { skipped: 'manual supplier or missing supplier product id' };
    try {
      const token = await this.token(sp.supplier);
      const r = sp.supplier.type === 'ALIEXPRESS' ? await aliexpressPriceStock(token, ref, sp.supplierSku) : await cjPriceStock(token, ref);
      const source = sp.supplier.type === 'ALIEXPRESS' ? 'aliexpress-api' : 'cj-api';
      if (!sp.currentPrice.equals(r.price) || sp.currency !== r.currency) {
        await this.suppliers.updatePrice(sp.id, { currentPrice: r.price, currency: r.currency, source, applyToCost: true }, null);
      }
      await this.suppliers.recordStock(sp.id, { stockStatus: r.stockStatus, reportedQuantity: r.reportedQuantity, source, manuallyVerified: false }, null);
      if (r.shipsFromCountry && r.shipsFromCountry !== sp.shipsFromCountry) await this.prisma.supplierProduct.update({ where: { id: sp.id }, data: { shipsFromCountry: r.shipsFromCountry } });
      await this.prisma.supplierConnection.update({ where: { supplierId: sp.supplierId }, data: { lastSyncAt: new Date(), lastError: null } });
      await this.inventorySync.syncVariant(sp.variantId);
      return { ok: true, ...r };
    } catch (e) {
      const msg = e instanceof ApiCallError ? e.opts.readable : (e as Error).message;
      await this.prisma.supplierConnection.updateMany({ where: { supplierId: sp.supplierId }, data: { lastError: msg } });
      return { ok: false, error: msg };
    }
  }

  async syncAll() {
    const sps = await this.prisma.supplierProduct.findMany({ where: { supplier: { connection: { status: 'CONNECTED' } } }, select: { id: true } });
    let ok = 0;
    for (const s of sps) if ((await this.syncSupplierProduct(s.id)).ok) ok++;
    return { checked: sps.length, ok };
  }

  /** Place the supplier order for a dropshipped customer order. Requires an explicit staff action. */
  async placeOrder(orderId: string, actor: AuthContext) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: { include: { variant: { include: { supplierProducts: { orderBy: { priority: 'asc' }, take: 1, include: { supplier: true } } } } } } },
    });
    if (!['PAID', 'AWAITING_DISPATCH'].includes(order.status)) throw new ConflictException({ code: 'ORDER_STATE', message: `Order is ${order.status}.` });
    const read = await this.pii.read(orderId, actor).catch(() => null);
    if (!read || read.purged) throw new ConflictException({ code: 'NO_ADDRESS', message: 'No shipping address is available for this order.' });
    const address = read as Exclude<typeof read, { purged: true }> & Record<string, string | null | undefined>;
    const results = [];
    for (const line of order.lines) {
      const sp = line.variant?.supplierProducts[0];
      if (!sp || !['ALIEXPRESS', 'CJ_DROPSHIPPING'].includes(sp.supplier.type)) {
        results.push({ lineId: line.id, ok: false, error: 'No API-connected supplier for this SKU; order manually and record the reference.' });
        continue;
      }
      const key = `supplier-order:${line.id}`;
      const existing = await this.prisma.supplierOrder.findUnique({ where: { idempotencyKey: key } });
      if (existing?.status === 'PLACED' || existing?.status === 'SHIPPED') {
        results.push({ lineId: line.id, ok: true, supplierOrderId: existing.id, externalOrderId: existing.externalOrderId, duplicate: true });
        continue;
      }
      const so = existing ?? (await this.prisma.supplierOrder.create({ data: { supplierId: sp.supplierId, orderId, idempotencyKey: key, status: 'DRAFT', currency: sp.currency } }));
      try {
        const token = await this.token(sp.supplier);
        const addr = { name: address.name ?? '', line1: address.line1 ?? '', line2: address.line2 ?? '', city: address.city ?? '', region: address.region ?? '', postcode: address.postcode ?? '', country: address.country ?? 'GB', phone: address.phone ?? '' };
        const reference = `FR-${order.orderNumber}-${line.id.slice(0, 6)}`;
        const r =
          sp.supplier.type === 'ALIEXPRESS'
            ? await aliexpressPlaceOrder(token, { productId: sp.supplierProductId!, skuAttr: sp.supplierSku, quantity: line.quantity, address: addr, reference })
            : await cjPlaceOrder(token, { vid: sp.supplierSku ?? sp.supplierProductId!, quantity: line.quantity, address: addr, reference });
        await this.prisma.supplierOrder.update({ where: { id: so.id }, data: { status: 'PLACED', externalOrderId: r.externalOrderId, placedAt: new Date(), placedById: actor.userId, totalCost: sp.currentPrice.plus(sp.shippingCost).times(line.quantity), lastError: null } });
        await this.prisma.fulfilment.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'SUPPLIER_ORDERED', supplierId: sp.supplierId, supplierOrderRef: r.externalOrderId } });
        results.push({ lineId: line.id, ok: true, supplierOrderId: so.id, externalOrderId: r.externalOrderId });
      } catch (e) {
        const msg = e instanceof ApiCallError ? e.opts.readable : (e as Error).message;
        await this.prisma.supplierOrder.update({ where: { id: so.id }, data: { status: 'FAILED', lastError: msg } });
        results.push({ lineId: line.id, ok: false, error: msg });
      }
    }
    await this.audit.record(actor, { action: 'order.supplier_order', entityType: 'order', entityId: orderId, after: results });
    return { results };
  }

  /** Manual supplier ordering: record the reference placed on the supplier's website. */
  async recordManualOrder(orderId: string, input: { supplierId: string; externalOrderId: string }, actor: AuthContext) {
    const so = await this.prisma.supplierOrder.create({ data: { supplierId: input.supplierId, orderId, externalOrderId: input.externalOrderId, status: 'PLACED', placedAt: new Date(), placedById: actor.userId, idempotencyKey: `manual:${orderId}:${input.externalOrderId}` } });
    await this.prisma.fulfilment.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'SUPPLIER_ORDERED', supplierId: input.supplierId, supplierOrderRef: input.externalOrderId } });
    await this.audit.record(actor, { action: 'order.supplier_order_manual', entityType: 'order', entityId: orderId, after: input });
    return so;
  }

  /** Poll suppliers for tracking; when found, forward it to the marketplace (marking the order dispatched). */
  async pollTracking() {
    const open = await this.prisma.supplierOrder.findMany({ where: { status: 'PLACED', externalOrderId: { not: null } }, include: { supplier: true } });
    let shipped = 0;
    for (const so of open) {
      try {
        if (!['ALIEXPRESS', 'CJ_DROPSHIPPING'].includes(so.supplier.type)) continue;
        const token = await this.token(so.supplier);
        const t = so.supplier.type === 'ALIEXPRESS' ? await aliexpressTracking(token, so.externalOrderId!) : await cjTracking(token, so.externalOrderId!);
        if (!t) continue;
        await this.prisma.supplierOrder.update({ where: { id: so.id }, data: { trackingNumber: t.trackingNumber, carrier: t.carrier } });
        try {
          await this.orders.recordShipment(so.orderId, { carrier: t.carrier, trackingNumber: t.trackingNumber, source: `${so.supplier.name} tracking` }, null);
          await this.prisma.supplierOrder.update({ where: { id: so.id }, data: { status: 'SHIPPED' } });
          shipped++;
        } catch (e) {
          await this.notifications.notify({ type: 'TRACKING_NOT_SENT', severity: 'warning', title: 'Supplier tracking could not be sent to the marketplace', body: (e as Error).message, entityType: 'order', entityId: so.orderId, roleKey: 'order_manager' });
        }
      } catch (e) {
        this.logger.warn(`Tracking poll ${so.id}: ${(e as Error).message}`);
      }
    }
    return { checked: open.length, shipped };
  }
}
