import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Observable, map } from 'rxjs';

/** Serialises Prisma/decimal.js Decimals as strings (never floats) and BigInts as strings. */
export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // isDecimal also recognises Decimal instances from other copies of decimal.js (e.g. @fr/core).
  if (Decimal.isDecimal(value) || Prisma.Decimal.isDecimal(value)) return (value as Decimal).toString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialize(v);
    return out;
  }
  return value;
}

@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serialize));
  }
}
