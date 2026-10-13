import { CurrencyCode, Decimal, Money, d, normaliseCurrency } from './money';

/**
 * A single exchange rate observation. `rate` converts 1 unit of `base` into `quote`.
 * Every conversion records the exact rate, its source and timestamp so historical
 * reports can be reproduced.
 */
export interface FxRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: Decimal | string | number;
  asOf: Date | string;
  source: string; // e.g. "manual", "ecb", "openexchangerates"
}

export interface FxConversion {
  original: Money;
  converted: Money;
  rate: Decimal;
  rateAsOf: string;
  rateSource: string;
  /** True when the inverse of a stored rate was used. */
  inverted: boolean;
}

export class MissingFxRateError extends Error {
  constructor(from: CurrencyCode, to: CurrencyCode, at?: Date) {
    super(
      `No exchange rate available for ${from}->${to}${at ? ` on or before ${at.toISOString()}` : ''}. ` +
        'Add a manual rate or enable the exchange-rate service; the platform never assumes 1:1.',
    );
    this.name = 'MissingFxRateError';
  }
}

export class FxTable {
  private readonly rates: FxRate[];

  constructor(rates: FxRate[]) {
    this.rates = rates.map((r) => ({
      ...r,
      base: normaliseCurrency(r.base),
      quote: normaliseCurrency(r.quote),
      rate: d(r.rate),
      asOf: new Date(r.asOf),
    }));
  }

  /**
   * Find the most recent rate at or before `at` (default: latest). Uses an inverse
   * rate if only the opposite direction is stored.
   */
  find(from: CurrencyCode, to: CurrencyCode, at?: Date): { rate: Decimal; asOf: Date; source: string; inverted: boolean } {
    const f = normaliseCurrency(from);
    const t = normaliseCurrency(to);
    if (f === t) return { rate: new Decimal(1), asOf: at ?? new Date(0), source: 'identity', inverted: false };
    const cutoff = at?.getTime() ?? Number.POSITIVE_INFINITY;
    const pick = (b: string, q: string) =>
      this.rates
        .filter((r) => r.base === b && r.quote === q && (r.asOf as Date).getTime() <= cutoff)
        .sort((x, y) => (y.asOf as Date).getTime() - (x.asOf as Date).getTime())[0];
    const direct = pick(f, t);
    const inverse = pick(t, f);
    // Prefer whichever observation is most recent.
    if (direct && (!inverse || (direct.asOf as Date) >= (inverse.asOf as Date))) {
      return { rate: d(direct.rate), asOf: direct.asOf as Date, source: direct.source, inverted: false };
    }
    if (inverse) {
      const r = d(inverse.rate);
      if (r.isZero()) throw new MissingFxRateError(f, t, at);
      return { rate: new Decimal(1).div(r), asOf: inverse.asOf as Date, source: inverse.source, inverted: true };
    }
    throw new MissingFxRateError(f, t, at);
  }

  convert(m: Money, to: CurrencyCode, at?: Date): FxConversion {
    const found = this.find(m.currency, to, at);
    return {
      original: m,
      converted: { amount: m.amount.times(found.rate), currency: normaliseCurrency(to) },
      rate: found.rate,
      rateAsOf: found.asOf.toISOString(),
      rateSource: found.source,
      inverted: found.inverted,
    };
  }
}
