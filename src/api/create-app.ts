import 'reflect-metadata';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from '../common/http-exception.filter.js';

/** Builds the HTTP app. Shared by main.api.ts and the HTTP tests so both run the same setup. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const swagger = new DocumentBuilder()
    .setTitle('Opportunities — Bulk Stage Move API')
    .setDescription(
      'Every route is scoped by the X-Workspace-Id header (tenant scoping, not auth). ' +
        'POST /v1/bulk-moves is idempotent per Idempotency-Key and never returns 409.',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  return app;
}
