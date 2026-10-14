import { Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { CryptoService } from '../common/crypto.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

export interface CustomerPii {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postcode?: string | null;
  /** ISO country; stored in clear (needed for VAT and shipping rules, not identifying on its own). */
  country?: string | null;
}

const SEALED_FIELDS = ['name', 'email', 'phone', 'line1', 'line2', 'city', 'region', 'postcode'] as const;
const DAY = 86_400_000;

/**
 * Customer personal data (buyer name, contact details, shipping address).
 *
 * - Every field is encrypted with AES-256-GCM before it reaches the database.
 * - Reading requires `orders.customer_pii` and every read is written to the audit log.
 * - Data is purged on a schedule: Amazon orders no later than 30 days after delivery
 *   (Amazon Data Protection Policy); other marketplaces after the configured retention.
 *   The retention clock starts at delivery, or at the order date when no delivery is
 *   recorded (which purges sooner, never later). Financial records are kept.
 */
@Injectable()
export class CustomerPiiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async retentionDays(marketplace: string) {
    return marketplace === 'AMAZON_UK'
      ? this.settings.get('privacy.amazon_pii_retention_days_after_delivery')
      : this.settings.get('privacy.customer_data_retention_days');
  }

  async purgeDateFor(orderId: string, deliveredAt?: Date | null, tx?: Tx) {
    const order = await (tx ?? this.prisma).order.findUniqueOrThrow({ where: { id: orderId }, select: { marketplace: true, orderedAt: true } });
    const start = deliveredAt ?? order.orderedAt;
    return new Date(start.getTime() + (await this.retentionDays(order.marketplace)) * DAY);
  }

  /** Store (or replace) the customer's details for an order, encrypted. Called by order import. */
  async store(orderId: string, pii: CustomerPii, tx?: Tx) {
    const db = tx ?? this.prisma;
    const sealed: Record<string, string | null> = {};
    for (const f of SEALED_FIELDS) sealed[f] = pii[f] ? this.crypto.seal(pii[f]!) : null;
    const purgeAfter = await this.purgeDateFor(orderId, null, tx);
    const data = { ...sealed, country: pii.country ?? null, purgeAfter, purgedAt: null };
    await db.orderCustomer.upsert({ where: { orderId }, update: data, create: { orderId, ...data } });
  }

  /** Delivery confirmed: restart the retention clock from the delivery date. */
  async markDelivered(orderId: string, deliveredAt: Date, tx?: Tx) {
    const purgeAfter = await this.purgeDateFor(orderId, deliveredAt, tx);
    await (tx ?? this.prisma).orderCustomer.updateMany({ where: { orderId, purgedAt: null }, data: { purgeAfter } });
  }

  async read(orderId: string, actor: AuthContext) {
    const row = await this.prisma.orderCustomer.findUnique({ where: { orderId } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No customer details stored for this order.' });
    await this.audit.record(actor, { action: 'customer_pii.read', entityType: 'order', entityId: orderId });
    if (row.purgedAt) return { orderId, purged: true, purgedAt: row.purgedAt, country: row.country };
    const out: CustomerPii & { orderId: string; purged: false; purgeAfter: Date | null } = { orderId, purged: false, purgeAfter: row.purgeAfter, country: row.country };
    for (const f of SEALED_FIELDS) out[f] = row[f] ? this.crypto.unseal(row[f]!) : null;
    return out;
  }

  /** Remove personal data whose retention period has ended. Idempotent; run hourly by the worker. */
  async purgeExpired(now = new Date()) {
    const r = await this.prisma.orderCustomer.updateMany({
      where: { purgedAt: null, purgeAfter: { lte: now } },
      data: { name: null, email: null, phone: null, line1: null, line2: null, city: null, region: null, postcode: null, purgedAt: now },
    });
    if (r.count > 0) await this.audit.record(null, { action: 'customer_pii.purge', entityType: 'order_customer', after: { purged: r.count } });
    return { purged: r.count };
  }
}

@ApiTags('Orders')
@Controller()
export class CustomerPiiController {
  constructor(private readonly pii: CustomerPiiService) {}

  @Get('orders/:id/customer')
  @RequirePermissions('orders.customer_pii')
  read(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.pii.read(id, auth);
  }

  @Post('privacy/purge')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  purge() {
    return this.pii.purgeExpired();
  }
}
