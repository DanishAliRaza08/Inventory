import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, FxTable, MissingFxRateError, add, formatMoney, money, roundMoney } from '../src';

describe('money', () => {
  it('avoids floating point errors', () => {
    expect(add(money('0.1', 'GBP'), money('0.2', 'GBP')).amount.toString()).toBe('0.3');
  });
  it('refuses to add different currencies', () => {
    expect(() => add(money(1, 'GBP'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
  });
  it('rounds half up to pennies and formats', () => {
    expect(roundMoney(money('2.345', 'GBP')).amount.toFixed(2)).toBe('2.35');
    expect(formatMoney(money('-3.5', 'USD'))).toBe('-$3.50');
    expect(formatMoney(money('11', 'GBP'))).toBe('£11.00');
  });
});

describe('fx', () => {
  const fx = new FxTable([
    { base: 'USD', quote: 'GBP', rate: '0.80', asOf: '2026-01-01T00:00:00Z', source: 'manual' },
    { base: 'USD', quote: 'GBP', rate: '0.75', asOf: '2026-06-01T00:00:00Z', source: 'manual' },
  ]);
  it('uses the rate in effect at the given time and records it', () => {
    const c = fx.convert(money(100, 'USD'), 'GBP', new Date('2026-03-01'));
    expect(c.converted.amount.toFixed(2)).toBe('80.00');
    expect(c.rateAsOf).toBe('2026-01-01T00:00:00.000Z');
    expect(fx.convert(money(100, 'USD'), 'GBP').converted.amount.toFixed(2)).toBe('75.00');
  });
  it('inverts a stored rate when needed', () => {
    const c = fx.convert(money(75, 'GBP'), 'USD', new Date('2026-07-01'));
    expect(c.converted.amount.toFixed(2)).toBe('100.00');
    expect(c.inverted).toBe(true);
  });
  it('never treats USD as GBP when no rate exists', () => {
    expect(() => fx.convert(money(1, 'USD'), 'GBP', new Date('2025-01-01'))).toThrow(MissingFxRateError);
    expect(() => new FxTable([]).convert(money(1, 'USD'), 'GBP')).toThrow(MissingFxRateError);
  });
});
