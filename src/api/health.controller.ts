/** Liveness + database check, used by the Docker healthcheck and handy for a quick smoke test. */
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Pool } from '../db/pool.js';
import { PG_POOL } from '../common/tokens.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  @ApiOkResponse({ schema: { example: { status: 'ok', db: 'up' } } })
  async check(): Promise<{ status: string; db: string }> {
    await this.pool.query('SELECT 1');
    return { status: 'ok', db: 'up' };
  }
}
