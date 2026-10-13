import { OrderLineProfitInput, ProfitBreakdown, calculateOrderLineProfit } from './profit';
import { Decimal, DecimalInput, d, round2 } from './money';

export type PriceTarget =
  | { kind: 'profit'; amount: DecimalInput } // desired net profit per order line
  | { kind: 'margin'; percent: DecimalInput }; // desired net profit margin on net revenue

export type PriceEnding = 'none' | '.99' | '.49_or_.99';

export interface ReversePriceInput {
  /** Everything needed to price one order line; `unitPrice` is the unknown. */
  base: Omit<OrderLineProfitInput, 'unitPrice' | 'actualFees' | 'refund' | 'settled'>;
  target: PriceTarget;
  ending?: PriceEnding;
  maxPrice?: DecimalInput;
}

export interface ReversePriceResult {
  achievable: boolean;
  unitPrice: Decimal | null;
  breakdown: ProfitBreakdown | null;
  message: string;
}

function meets(b: ProfitBreakdown, target: PriceTarget): boolean {
  if (target.kind === 'profit') return b.netProfit.gte(d(target.amount));
  if (b.netRevenue.lte(0)) return false;
  // Compare on unrounded margin to avoid accepting a price that only rounds up to target.
  return b.netProfit.div(b.netRevenue).times(100).gte(d(target.percent));
}

function applyEnding(price: Decimal, ending: PriceEnding): Decimal {
  if (ending === 'none') return price;
  const whole = price.floor();
  const cands = ending === '.99' ? [whole.plus(0.99), whole.plus(1.99)] : [whole.plus(0.49), whole.plus(0.99), whole.plus(1.49)];
  return cands.find((c) => c.gte(price)) ?? price;
}

/**
 * Solve for the lowest unit price (to the penny) that meets a profit or margin
 * target, using the exact forward profit calculation (so tiered, capped and
 * fixed fees are all respected). Assumes profit is non-decreasing in price,
 * which holds whenever percentage fees total less than 100%.
 */
export function solveUnitPrice(input: ReversePriceInput): ReversePriceResult {
  const evalAt = (price: Decimal) => calculateOrderLineProfit({ ...input.base, unitPrice: price });
  if (input.target.kind === 'margin' && d(input.target.percent).gte(100)) {
    return { achievable: false, unitPrice: null, breakdown: null, message: 'A net margin of 100% or more is impossible.' };
  }
  let lo = new Decimal(0);
  let hi = new Decimal(1);
  const cap = d(input.maxPrice ?? 1_000_000);
  while (!meets(evalAt(hi), input.target)) {
    lo = hi;
    hi = hi.times(2);
    if (hi.gt(cap)) {
      return {
        achievable: false,
        unitPrice: null,
        breakdown: null,
        message: 'Target not reachable below the maximum price. Percentage fees may total 100% or more, or costs are misconfigured.',
      };
    }
  }
  // Bisection in pennies.
  let loP = lo.times(100).floor();
  let hiP = hi.times(100).ceil();
  while (hiP.minus(loP).gt(1)) {
    const mid = loP.plus(hiP).div(2).floor();
    if (meets(evalAt(mid.div(100)), input.target)) hiP = mid;
    else loP = mid;
  }
  let price = hiP.div(100);
  if (meets(evalAt(loP.div(100)), input.target)) price = loP.div(100);
  price = applyEnding(round2(price), input.ending ?? 'none');
  const breakdown = evalAt(price);
  return { achievable: true, unitPrice: price, breakdown, message: 'ok' };
}

/** Lowest price at which the line does not lose money. */
export function breakEvenPrice(base: ReversePriceInput['base']): ReversePriceResult {
  return solveUnitPrice({ base, target: { kind: 'profit', amount: 0 } });
}
