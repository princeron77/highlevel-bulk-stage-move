/** Provides the API's pg Pool to every controller and closes it on shutdown (SIGTERM). */
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { dbConfig } from '../config.js';
import { createPool, type Pool } from '../db/pool.js';
import { PG_POOL } from '../common/tokens.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      // why: API pool is sized for interactive traffic; the worker has its own small pool.
      useFactory: (): Pool => createPool(dbConfig().connectionString, 20, 'api'),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
