import { ArgumentMetadata, BadRequestException, PipeTransform, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown, _meta: ArgumentMetadata): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

/** Documents a zod body schema in OpenAPI. Pair with `@Body(new ZodPipe(schema))`. */
export function ApiZodBody(schema: ZodTypeAny, description?: string) {
  return applyDecorators(ApiBody({ description, schema: zodToJsonSchema(schema, { target: 'openApi3' }) as object }));
}

export function ApiZodQuery(schema: z.AnyZodObject) {
  const shape = schema.shape as Record<string, ZodTypeAny>;
  return applyDecorators(...Object.keys(shape).map((name) => ApiQuery({ name, required: false })));
}

export const zMoney = z.union([z.string(), z.number()]).pipe(z.coerce.string().regex(/^-?\d+(\.\d{1,4})?$/, 'Must be a decimal amount with up to 4 decimal places'));
export const zMoneyNonNeg = zMoney.refine((s) => !s.startsWith('-'), 'Must not be negative');
export const zCurrency = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/, 'Must be a 3-letter ISO currency code'));
export const zUuid = z.string().uuid();
export const zPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
