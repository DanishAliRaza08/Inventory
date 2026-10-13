import Decimal from 'decimal.js';

/**
 * All monetary arithmetic in the platform goes through Decimal (never JS floats).
 * Amounts are carried at full precision internally and rounded to minor units
 * (2 dp for GBP/USD/EUR) only at well-defined points: each fee line, each
 * cost line, and the final displayed figures.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export const SUPPORTED_CURRENCIES = ['GBP', 'USD', 'EUR', 'CNY'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number] | (string & {});

export type DecimalInput = Decimal | number | string;

export interface Money {
  amount: Decimal;
  currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode, context?: string) {
    super(
      `Currency mismatch${context ? ` in ${context}` : ''}: ${a} vs ${b}. ` +
        'Convert explicitly with an exchange rate; amounts in different currencies are never combined implicitly.',
    );
    this.name = 'CurrencyMismatchError';
  }
}

export function d(value: DecimalInput | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return value instanceof Decimal ? value : new Decimal(value);
}

export function money(amount: DecimalInput, currency: CurrencyCode): Money {
  return { amount: d(amount), currency: normaliseCurrency(currency) };
}

export function normaliseCurrency(currency: string): CurrencyCode {
  const c = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`Invalid ISO-4217 currency code: "${currency}"`);
  return c;
}

export function assertSameCurrency(a: Money, b: Money, context?: string): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency, context);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'add');
  return { amount: a.amount.plus(b.amount), currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'sub');
  return { amount: a.amount.minus(b.amount), currency: a.currency };
}

export function sum(items: Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

export function mul(a: Money, factor: DecimalInput): Money {
  return { amount: a.amount.times(d(factor)), currency: a.currency };
}

/** Round to currency minor units (2 dp for all currencies the platform supports today). */
export function roundMoney(a: Money, dp = 2): Money {
  return { amount: a.amount.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP), currency: a.currency };
}

export function round2(x: Decimal): Decimal {
  return x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function formatMoney(m: Money): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  const s = symbols[m.currency];
  const amt = round2(m.amount);
  const sign = amt.isNegative() ? '-' : '';
  const abs = amt.abs().toFixed(2);
  return s ? `${sign}${s}${abs}` : `${sign}${abs} ${m.currency}`;
}

export function toJSONMoney(m: Money): { amount: string; currency: string } {
  return { amount: round2(m.amount).toFixed(2), currency: m.currency };
}
