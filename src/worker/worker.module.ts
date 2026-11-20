import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dbConfig, workerConfig } from '../config.js';
import { createPool, type Pool } from '../db/pool.js';
import { PG_POOL } from '../common/tokens.js';
import { BulkWorker } from '../engine/worker.js';

/** Runs the worker loop for the lifetime of the process and stops it cleanly on SIGTERM. */
@Injectable()
export class WorkerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BulkWorker');
  private readonly stop = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  onApplicationBootstrap(): void {
    const id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const log = {
      log: (m: string, c?: object) => this.logger.log({ ...c, workerId: id }, m),
      warn: (m: string, c?: object) => this.logger.warn({ ...c, workerId: id }, m),
      error: (m: string, c?: object) => this.logger.error({ ...c, workerId: id }, m),
    };
    const worker = new BulkWorker(this.pool, workerConfig(), id, log);
    this.logger.log({ workerId: id, config: workerConfig() }, 'worker started');
    this.loop = worker.run(this.stop.signal);
  }

  /** SIGTERM: finish the current chunk, hand the job back, close the pool. */
  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.loop;
    await this.pool.end();
  }
}

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: { level: process.env.LOG_LEVEL ?? 'info' } })],
  providers: [
    // why: a small, separate pool; the worker can never use up the API's connections.
    { provide: PG_POOL, useFactory: (): Pool => createPool(dbConfig().connectionString, 4, 'worker') },
    WorkerRunner,
  ],
})
export class WorkerModule {}
