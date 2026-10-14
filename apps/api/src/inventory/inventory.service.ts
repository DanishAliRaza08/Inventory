import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InventoryRecord, Prisma, StockBucket } from '@prisma/client';
import { DEFAULT_DROPSHIP_SETTINGS, DropshipSettings, dropshipAvailableToSell, physicalAvailableToSell } from '@fr/core';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';

const BUCKET_FIELD: Record<Exclude<StockBucket, 'EXTERNAL'>, keyof Pick<InventoryRecord, 'available' | 'reserved' | 'committed' | 'damaged' | 'returned'>> = {
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  COMMITTED: 'committed',
  DAMAGED: 'damaged',
  RETURNED: 'returned',
};

/** Allowed movement types and the bucket transitions they represent. */
export const MOVEMENT_TYPES = {
  RECEIVE: { from: 'EXTERNAL', to: 'AVAILABLE' },
  RESERVE: { from: 'AVAILABLE', to: 'RESERVED' },
  RELEASE: { from: 'RESERVED', to: 'AVAILABLE' },
  COMMIT: { from: 'RESERVED', to: 'COMMITTED' },
  UNCOMMIT: { from: 'COMMITTED', to: 'AVAILABLE' },
  SHIP: { from: 'COMMITTED', to: 'EXTERNAL' },
  RETURN: { from: 'EXTERNAL', to: 'RETURNED' },
  RESTOCK: { from: 'RETURNED', to: 'AVAILABLE' },
  DAMAGE: { from: 'AVAILABLE', to: 'DAMAGED' },
  RETURN_DAMAGED: { from: 'RETURNED', to: 'DAMAGED' },
  WRITE_OFF: { from: 'DAMAGED', to: 'EXTERNAL' },
  ADJUST_UP: { from: 'EXTERNAL', to: 'AVAILABLE' },
  ADJUST_DOWN: { from: 'AVAILABLE', to: 'EXTERNAL' },
} as const satisfies Record<string, { from: StockBucket; to: StockBucket }>;

export const MovementInput = z.object({
  type: z.enum(Object.keys(MOVEMENT_TYPES) as [keyof typeof MOVEMENT_TYPES, ...Array<keyof typeof MOVEMENT_TYPES>]),
  quantity: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  location: z.string().default('MAIN'),
  /** Supply a stable key (e.g. order line id + action) so retries never double-apply. */
  idempotencyKey: z.string().max(200).optional(),
});

export const InventorySettingsInput = z.object({
  safetyStock: z.number().int().nonnegative().optional(),
  policy: z.enum(['MANUAL', 'SUPPLIER_MONITOR', 'AUTO_SYNC', 'AUTO_PAUSE']).optional(),
  allocationMode: z.enum(['SHARED', 'FIXED', 'PERCENTAGE']).optional(),
  requireRelistApproval: z.boolean().optional(),
  dropshipSettings: z
    .object({
      bufferPercent: z.number().min(0).max(100),
      bufferUnits: z.number().int().min(0),
      maxAdvertised: z.number().int().min(0),
      staleAfterHours: z.number().positive(),
      defaultWhenUnreported: z.number().int().min(0),
    })
    .optional(),
  notes: z.string().max(2000).optional(),
});

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async ensureRecord(variantId: string, location = 'MAIN', tx?: Tx) {
    const db = tx ?? this.prisma;
    return db.inventoryRecord.upsert({ where: { variantId_location: { variantId, location } }, update: {}, create: { variantId, location } });
  }

  /**
   * Apply a stock movement atomically. The inventory row is locked (SELECT … FOR UPDATE) for the
   * duration of the transaction, buckets are checked before decrementing and the database CHECK
   * constraint guarantees no bucket ever goes negative. Re-sending the same idempotency key
   * returns the original movement without changing stock again.
   */
  async move(variantId: string, input: z.infer<typeof MovementInput>, actor: AuthContext | null, txIn?: Tx) {
    const run = async (tx: Tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.inventoryMovement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return { movement: existing, duplicate: true };
      }
      const rec = await this.ensureRecord(variantId, input.location, tx);
      await tx.$queryRaw`SELECT id FROM inventory_records WHERE id = ${rec.id}::uuid FOR UPDATE`;
      const locked = await tx.inventoryRecord.findUniqueOrThrow({ where: { id: rec.id } });
      const t = MOVEMENT_TYPES[input.type];
      const data: Prisma.InventoryRecordUpdateInput = { version: { increment: 1 }, lastCheckedAt: new Date() };
      if (t.from !== 'EXTERNAL') {
        const field = BUCKET_FIELD[t.from];
        if (locked[field] < input.quantity) {
          throw new ConflictException({ code: 'INSUFFICIENT_STOCK', message: `Cannot move ${input.quantity} from ${t.from}: only ${locked[field]} available.` });
        }
        data[field] = { decrement: input.quantity };
      }
      if (t.to !== 'EXTERNAL') data[BUCKET_FIELD[t.to]] = { increment: input.quantity };
      const updated = await tx.inventoryRecord.update({ where: { id: rec.id }, data });
      const movement = await tx.inventoryMovement.create({
        data: {
          inventoryRecordId: rec.id,
          type: input.type,
          fromBucket: t.from,
          toBucket: t.to,
          quantity: input.quantity,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          createdById: actor?.userId,
        },
      });
      await this.audit.record(actor, { action: `inventory.${input.type.toLowerCase()}`, entityType: 'variant', entityId: variantId, before: locked, after: updated }, tx);
      return { movement, record: updated, duplicate: false };
    };
    try {
      return txIn ? await run(txIn) : await this.prisma.$transaction(run);
    } catch (e) {
      // A concurrent request with the same idempotency key won the race.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && input.idempotencyKey) {
        const existing = await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return { movement: existing, duplicate: true };
      }
      throw e;
    }
  }

  /** Stock count: set AVAILABLE to the counted quantity via an explicit adjustment movement. */
  async count(variantId: string, counted: number, reason: string, actor: AuthContext, location = 'MAIN') {
    if (!Number.isInteger(counted) || counted < 0) throw new BadRequestException({ code: 'INVALID_COUNT', message: 'Count must be a non-negative integer.' });
    return this.prisma.$transaction(async (tx) => {
      const rec = await this.ensureRecord(variantId, location, tx);
      await tx.$queryRaw`SELECT id FROM inventory_records WHERE id = ${rec.id}::uuid FOR UPDATE`;
      const current = await tx.inventoryRecord.findUniqueOrThrow({ where: { id: rec.id } });
      const diff = counted - current.available;
      if (diff === 0) return { movement: null, record: current };
      return this.move(variantId, { type: diff > 0 ? 'ADJUST_UP' : 'ADJUST_DOWN', quantity: Math.abs(diff), reason: `Stock count: ${reason}`, location }, actor, tx);
    });
  }

  async updateSettings(variantId: string, input: z.infer<typeof InventorySettingsInput>, actor: AuthContext, location = 'MAIN') {
    const before = await this.ensureRecord(variantId, location);
    const after = await this.prisma.inventoryRecord.update({
      where: { id: before.id },
      data: { ...input, dropshipSettings: input.dropshipSettings ?? undefined, version: { increment: 1 } },
    });
    await this.audit.record(actor, { action: 'inventory.settings', entityType: 'variant', entityId: variantId, before, after });
    return after;
  }

  /** Available-to-sell for a SKU, computed according to its fulfilment model. */
  async availability(variantId: string) {
    const v = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { select: { fulfilmentModel: true } }, inventory: true, supplierProducts: { orderBy: { priority: 'asc' } } },
    });
    if (!v) throw new NotFoundException();
    const rec = v.inventory.find((i) => i.location === 'MAIN') ?? (await this.ensureRecord(variantId));
    if (v.product.fulfilmentModel === 'PHYSICAL') {
      const { available, reserved, committed, damaged, returned, safetyStock } = rec;
      return { ...physicalAvailableToSell({ available, reserved, committed, damaged, returned, safetyStock }), record: rec };
    }
    const settings: DropshipSettings = { ...DEFAULT_DROPSHIP_SETTINGS, ...((rec.dropshipSettings as Partial<DropshipSettings> | null) ?? {}) };
    const primary = v.supplierProducts[0];
    if (!primary) return { model: 'DROPSHIP' as const, availableToSell: 0, stale: true, reasons: ['No supplier linked'], record: rec };
    return {
      ...dropshipAvailableToSell(
        {
          status: primary.stockStatus,
          reportedQuantity: primary.reportedQuantity,
          checkedAt: primary.stockCheckedAt,
          manuallyVerifiedAt: primary.manuallyVerifiedAt,
          source: primary.stockSource ?? 'unknown',
        },
        settings,
      ),
      record: rec,
      supplier: { id: primary.supplierId, status: primary.stockStatus, reportedQuantity: primary.reportedQuantity, checkedAt: primary.stockCheckedAt, source: primary.stockSource },
    };
  }

  movements(variantId: string) {
    return this.prisma.inventoryMovement.findMany({ where: { inventoryRecord: { variantId } }, orderBy: { createdAt: 'desc' }, take: 200 });
  }
}
