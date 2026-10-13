/**
 * Inventory availability and allocation.
 *
 * Owned (physical) stock and supplier (dropship) availability are modelled
 * separately and never mixed: supplier-reported quantities are treated as an
 * unverified signal, discounted by a safety buffer and expired when stale.
 */

export type FulfilmentModel = 'PHYSICAL' | 'DROPSHIP';

export type InventoryPolicy =
  | 'MANUAL' // operator sets quantities; no automatic pushes
  | 'SUPPLIER_MONITOR' // watch supplier availability and alert only
  | 'AUTO_SYNC' // push calculated quantity automatically
  | 'AUTO_PAUSE'; // push quantity and pause listings when unavailable

/** Disjoint stock buckets for physically held stock. */
export interface PhysicalStock {
  available: number; // on hand, not reserved or committed
  reserved: number; // held for orders not yet paid / confirmed
  committed: number; // paid orders awaiting dispatch
  damaged: number;
  returned: number; // returned, awaiting inspection
  safetyStock: number;
}

export interface SupplierAvailability {
  status: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN' | 'DISCONTINUED';
  reportedQuantity: number | null;
  checkedAt: Date | string | null;
  source: string; // "cj-api", "aliexpress-manual", "supplier-email", ...
  manuallyVerifiedAt?: Date | string | null;
}

export interface DropshipSettings {
  /** Percentage of supplier-reported quantity to advertise (e.g. 50 = half). */
  bufferPercent: number;
  /** Units always held back from the supplier figure. */
  bufferUnits: number;
  /** Never advertise more than this many units. */
  maxAdvertised: number;
  /** Supplier data older than this is considered stale. */
  staleAfterHours: number;
  /** Quantity to advertise when status is IN_STOCK but no number is reported. */
  defaultWhenUnreported: number;
}

export const DEFAULT_DROPSHIP_SETTINGS: DropshipSettings = {
  bufferPercent: 50,
  bufferUnits: 2,
  maxAdvertised: 10,
  staleAfterHours: 48,
  defaultWhenUnreported: 3,
};

export interface AvailabilityResult {
  model: FulfilmentModel;
  availableToSell: number;
  stale: boolean;
  reasons: string[];
}

export function physicalAvailableToSell(s: PhysicalStock): AvailabilityResult {
  for (const [k, v] of Object.entries(s)) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`Stock bucket ${k} must be a non-negative integer (got ${v}).`);
  }
  const ats = Math.max(0, s.available - s.safetyStock);
  const reasons: string[] = [];
  if (s.safetyStock > 0) reasons.push(`${Math.min(s.safetyStock, s.available)} unit(s) held as safety stock`);
  if (ats === 0) reasons.push('No sellable stock');
  return { model: 'PHYSICAL', availableToSell: ats, stale: false, reasons };
}

export function dropshipAvailableToSell(
  a: SupplierAvailability,
  settings: DropshipSettings = DEFAULT_DROPSHIP_SETTINGS,
  now = new Date(),
): AvailabilityResult {
  const reasons: string[] = [];
  const checked = a.manuallyVerifiedAt ?? a.checkedAt;
  const ageHours = checked ? (now.getTime() - new Date(checked).getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
  const stale = ageHours > settings.staleAfterHours;
  if (stale) {
    reasons.push(checked ? `Supplier data is ${Math.round(ageHours)}h old (limit ${settings.staleAfterHours}h)` : 'Supplier stock has never been checked');
    return { model: 'DROPSHIP', availableToSell: 0, stale: true, reasons };
  }
  if (a.status === 'OUT_OF_STOCK' || a.status === 'DISCONTINUED' || a.status === 'UNKNOWN') {
    reasons.push(`Supplier status ${a.status}`);
    return { model: 'DROPSHIP', availableToSell: 0, stale: false, reasons };
  }
  let qty: number;
  if (a.reportedQuantity === null || a.reportedQuantity === undefined) {
    qty = settings.defaultWhenUnreported;
    reasons.push('Supplier reports in-stock without a quantity; using configured default');
  } else {
    qty = Math.floor((a.reportedQuantity * settings.bufferPercent) / 100) - settings.bufferUnits;
    reasons.push(`Supplier reports ${a.reportedQuantity}; advertising ${settings.bufferPercent}% less ${settings.bufferUnits} buffer unit(s)`);
  }
  qty = Math.max(0, Math.min(qty, settings.maxAdvertised));
  if (qty === settings.maxAdvertised) reasons.push(`Capped at ${settings.maxAdvertised}`);
  return { model: 'DROPSHIP', availableToSell: qty, stale: false, reasons };
}

export type AllocationMode = 'SHARED' | 'FIXED' | 'PERCENTAGE';

export interface ListingAllocationInput {
  listingId: string;
  status: 'ACTIVE' | 'PAUSED' | 'OTHER';
  currentQuantity: number;
  /** FIXED: max units for this listing. PERCENTAGE: share of the pool (0-100). */
  allocation?: number;
  /** Listing was paused automatically for unavailability (eligible for automatic resume). */
  autoPaused?: boolean;
}

export interface ListingSyncAction {
  listingId: string;
  action: 'NONE' | 'UPDATE_QUANTITY' | 'PAUSE' | 'RESUME' | 'NEEDS_RELIST_APPROVAL' | 'ALERT_ONLY';
  targetQuantity: number;
  reason: string;
}

/**
 * Decide what each listing in an inventory pool should advertise.
 * Never resumes a listing that a human paused; resumes auto-paused listings only
 * when manual relist approval is not required.
 */
export function planInventorySync(params: {
  policy: InventoryPolicy;
  availableToSell: number;
  mode: AllocationMode;
  listings: ListingAllocationInput[];
  requireRelistApproval: boolean;
  syncDisabled?: boolean;
}): ListingSyncAction[] {
  const { policy, availableToSell, mode, listings } = params;
  const live = listings.filter((l) => l.status !== 'OTHER');
  return live.map((l): ListingSyncAction => {
    let target: number;
    if (mode === 'SHARED') target = availableToSell;
    else if (mode === 'FIXED') target = Math.min(availableToSell, Math.max(0, l.allocation ?? 0));
    else target = Math.floor((availableToSell * Math.max(0, Math.min(100, l.allocation ?? 0))) / 100);

    if (params.syncDisabled) return { listingId: l.listingId, action: 'NONE', targetQuantity: l.currentQuantity, reason: 'Inventory sync disabled by emergency control' };
    if (policy === 'MANUAL') return { listingId: l.listingId, action: 'NONE', targetQuantity: l.currentQuantity, reason: 'Manual inventory policy' };
    if (policy === 'SUPPLIER_MONITOR') {
      return target !== l.currentQuantity
        ? { listingId: l.listingId, action: 'ALERT_ONLY', targetQuantity: target, reason: `Calculated ${target}, listing shows ${l.currentQuantity}` }
        : { listingId: l.listingId, action: 'NONE', targetQuantity: target, reason: 'In line' };
    }
    if (target === 0 && policy === 'AUTO_PAUSE' && l.status === 'ACTIVE') {
      return { listingId: l.listingId, action: 'PAUSE', targetQuantity: 0, reason: 'No available stock' };
    }
    if (l.status === 'PAUSED') {
      if (target > 0 && l.autoPaused) {
        return params.requireRelistApproval
          ? { listingId: l.listingId, action: 'NEEDS_RELIST_APPROVAL', targetQuantity: target, reason: 'Stock is back; relist requires approval' }
          : { listingId: l.listingId, action: 'RESUME', targetQuantity: target, reason: 'Stock is back' };
      }
      return { listingId: l.listingId, action: 'NONE', targetQuantity: l.currentQuantity, reason: l.autoPaused ? 'Still unavailable' : 'Paused by a user' };
    }
    if (target !== l.currentQuantity) return { listingId: l.listingId, action: 'UPDATE_QUANTITY', targetQuantity: target, reason: `Quantity ${l.currentQuantity} -> ${target}` };
    return { listingId: l.listingId, action: 'NONE', targetQuantity: target, reason: 'In line' };
  });
}
