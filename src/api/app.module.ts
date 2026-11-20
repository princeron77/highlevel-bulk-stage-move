/**
 * Root module of the API process: structured request logging (pino, with a request id that
 * also appears in every error response), the Postgres pool, and the controllers.
 */
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { DatabaseModule } from './database.module.js';
import { HealthController } from './health.controller.js';
import { OpportunitiesController } from './opportunities/opportunities.controller.js';
import { BulkMovesController } from './bulk-moves/bulk-moves.controller.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // why: reuse a caller's request id if given, so a client retry can be traced end to end.
        genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        autoLogging: process.env.NODE_ENV !== 'test',
        redact: ['req.headers.authorization'],
      },
    }),
    DatabaseModule,
  ],
  controllers: [HealthController, OpportunitiesController, BulkMovesController],
})
export class AppModule {}
