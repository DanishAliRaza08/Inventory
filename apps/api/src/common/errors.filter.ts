import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrencyMismatchError, MissingFxRateError, NoCostRecordError, TransitionError } from '@fr/core';
import { Response } from 'express';

/** Maps domain and database errors to consistent, readable API errors. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body = typeof r === 'string' ? { code: HttpStatus[status], message: r } : { code: HttpStatus[status], ...(r as object) };
    } else if (exception instanceof TransitionError) {
      status = exception.code === 'FORBIDDEN' ? 403 : 409;
      body = { code: exception.code, message: exception.message };
    } else if (exception instanceof MissingFxRateError || exception instanceof CurrencyMismatchError || exception instanceof NoCostRecordError) {
      status = 422;
      body = { code: exception.name, message: exception.message };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = 409;
        body = { code: 'DUPLICATE', message: `A record with the same ${(exception.meta?.target as string[] | undefined)?.join(', ') ?? 'unique value'} already exists.` };
      } else if (exception.code === 'P2025') {
        status = 404;
        body = { code: 'NOT_FOUND', message: 'Record not found.' };
      } else if (exception.code === 'P2003') {
        status = 409;
        body = { code: 'IN_USE', message: 'The record is referenced by other records.' };
      }
    } else if (exception instanceof Prisma.PrismaClientUnknownRequestError && /violates check constraint/.test(exception.message)) {
      status = 422;
      body = { code: 'CONSTRAINT_VIOLATION', message: exception.message.split('\n').pop() };
    }
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(status).json({ statusCode: status, ...body });
  }
}
