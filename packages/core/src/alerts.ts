import { ProfitBreakdown } from './profit';
import { Decimal, DecimalInput, d } from './money';

export interface ProfitAlertThresholds {
  minProfit: DecimalInput; // e.g. 3.00 in the listing currency
  minMarginPercent: DecimalInput; // e.g. 15
  maxRefundRatePercent: DecimalInput; // e.g. 10
  costStaleAfterDays: number; // e.g. 30
  supplierPriceIncreasePercent: DecimalInput; // e.g. 5
  unexpectedFeeVariancePercent: DecimalInput; // actual vs estimated, e.g. 15
}

export type AlertCode =
  | 'NEGATIVE_PROFIT'
  | 'LOW_PROFIT'
  | 'LOW_MARGIN'
  | 'BELOW_MIN_PROFITABLE_PRICE'
  | 'SUPPLIER_PRICE_INCREASE'
  | 'UNEXPECTED_FEES'
  | 'HIGH_REFUND_RATE'
  | 'COST_UNVERIFIED';

export interface Alert {
  code: AlertCode;
  severity: 'critical' | 'warning' | 'info';
  message: string;
}

export function profitAlerts(b: ProfitBreakdown, t: ProfitAlertThresholds): Alert[] {
  const out: Alert[] = [];
  if (b.netProfit.lte(0)) {
    out.push({ code: 'NEGATIVE_PROFIT', severity: 'critical', message: `Estimated profit is ${b.netProfit.toFixed(2)} ${b.currency}.` });
  } else if (b.netProfit.lt(d(t.minProfit))) {
    out.push({ code: 'LOW_PROFIT', severity: 'warning', message: `Profit ${b.netProfit.toFixed(2)} is below ${d(t.minProfit).toFixed(2)} ${b.currency}.` });
  }
  if (b.netMarginPercent !== null && b.netProfit.gt(0) && b.netMarginPercent.lt(d(t.minMarginPercent))) {
    out.push({ code: 'LOW_MARGIN', severity: 'warning', message: `Margin ${b.netMarginPercent.toFixed(2)}% is below ${d(t.minMarginPercent).toString()}%.` });
  }
  return out;
}

export function supplierPriceChangeAlert(previous: DecimalInput, next: DecimalInput, t: ProfitAlertThresholds): Alert | null {
  const p = d(previous);
  if (p.lte(0)) return null;
  const change = d(next).minus(p).div(p).times(100);
  if (change.gte(d(t.supplierPriceIncreasePercent))) {
    return { code: 'SUPPLIER_PRICE_INCREASE', severity: 'warning', message: `Supplier price increased ${change.toFixed(1)}% (${p.toFixed(2)} -> ${d(next).toFixed(2)}).` };
  }
  return null;
}

export function feeVarianceAlert(estimated: DecimalInput, actual: DecimalInput, t: ProfitAlertThresholds): Alert | null {
  const e = d(estimated);
  const a = d(actual);
  if (e.isZero()) return a.gt(0) ? { code: 'UNEXPECTED_FEES', severity: 'warning', message: `Fees of ${a.toFixed(2)} charged where none were expected.` } : null;
  const variance = a.minus(e).div(e).times(100);
  if (variance.abs().gte(d(t.unexpectedFeeVariancePercent))) {
    return { code: 'UNEXPECTED_FEES', severity: 'warning', message: `Actual fees ${a.toFixed(2)} differ from estimate ${e.toFixed(2)} by ${variance.toFixed(1)}%.` };
  }
  return null;
}

export function refundRateAlert(unitsSold: number, unitsRefunded: number, t: ProfitAlertThresholds): Alert | null {
  if (unitsSold <= 0) return null;
  const rate = new Decimal(unitsRefunded).div(unitsSold).times(100);
  return rate.gt(d(t.maxRefundRatePercent))
    ? { code: 'HIGH_REFUND_RATE', severity: 'warning', message: `Refund rate ${rate.toFixed(1)}% exceeds ${d(t.maxRefundRatePercent).toString()}%.` }
    : null;
}
