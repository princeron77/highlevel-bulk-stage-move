import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId: string | undefined;
}

/** One error shape for every endpoint: { statusCode, error, message, requestId }. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      message =
        typeof payload === 'object' && payload !== null && 'message' in payload
          ? (payload as { message: string | string[] }).message
          : exception.message;
    } else {
      // why: never leak driver/SQL details to clients; log them with the request id instead.
      this.logger.error({ err: exception, requestId: request.id }, 'Unhandled error');
    }

    const body: ErrorBody = {
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message,
      requestId: request.id,
    };
    response.status(status).json(body);
  }
}
