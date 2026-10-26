import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { AppError } from '../domain/errors';
import { log } from '../observability';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof AppError
        ? error.httpStatus
        : error instanceof HttpException
          ? error.getStatus()
          : 503;
    const code =
      error instanceof AppError
        ? error.code
        : status < 500
          ? 'INVALID_REQUEST'
          : 'INFRASTRUCTURE_UNAVAILABLE';
    if (status >= 500) log('error', 'request_failed', { code });
    if (status === 503) response.setHeader('retry-after', '2');
    response.status(status).json({ code });
  }
}
