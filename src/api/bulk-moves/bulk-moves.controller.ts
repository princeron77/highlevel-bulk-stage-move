import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { workerConfig } from '../../config.js';
import type { Pool } from '../../db/pool.js';
import { PG_POOL } from '../../common/tokens.js';
import { WorkspaceId } from '../../common/workspace.decorator.js';
import { getProgress, listItems, type JobProgress } from '../../engine/progress.js';
import { submitBulkMove } from '../../engine/submit.js';
import { ItemsQueryDto, JobProgressDto, SubmitBulkMoveDto, SubmitBulkMoveResponseDto } from './bulk-moves.dto.js';

@ApiTags('bulk moves (Part 2)')
@ApiHeader({
  name: 'X-Workspace-Id',
  required: true,
  description: 'Tenant scope. Seeded examples: b0000000-0000-4000-8000-000000000001 (small), a0000000-0000-4000-8000-000000000000 (large)',
})
@Controller('v1/bulk-moves')
export class BulkMovesController {
  private readonly leaseMs = workerConfig().leaseMs;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post()
  @ApiOperation({
    summary: 'Submit a bulk stage move (returns immediately with a job handle)',
    description:
      'Freezes the matching set (max 50,000) at submit time and queues a background job.\n\n' +
      '**Idempotency:** the first request returns 202. Retrying with the same Idempotency-Key and the same body ' +
      'returns 200 with the same jobId, including when duplicates arrive concurrently. It never returns 409. ' +
      'The same key with a different body returns 422.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '1-200 chars, unique per intended operation (e.g. a UUID).' })
  @ApiAcceptedResponse({ type: SubmitBulkMoveResponseDto, description: 'Job created.' })
  @ApiOkResponse({ type: SubmitBulkMoveResponseDto, description: 'Replay of an already-accepted request: same jobId.' })
  @ApiNotFoundResponse({ description: 'Target stage not in this workspace.' })
  @ApiUnprocessableEntityResponse({ description: 'Key reused with a different body, or more than 50,000 matches.' })
  async submit(
    @WorkspaceId() workspaceId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SubmitBulkMoveDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitBulkMoveResponseDto> {
    if (!key || key.length > 200) {
      throw new BadRequestException('Idempotency-Key header is required (1-200 characters)');
    }
    const result = await submitBulkMove(this.pool, workspaceId, key, body);
    const progressUrl = `/v1/bulk-moves/${result.jobId}`;
    res.status(result.replayed ? 200 : 202).setHeader('Location', progressUrl);
    return { jobId: result.jobId, replayed: result.replayed, progressUrl };
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'Job progress from committed state (status, counts, percent, health)' })
  @ApiOkResponse({ type: JobProgressDto })
  @ApiNotFoundResponse({ description: 'No such job in this workspace.' })
  progress(
    @WorkspaceId() workspaceId: string,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ): Promise<JobProgress> {
    return getProgress(this.pool, workspaceId, jobId, this.leaseMs);
  }

  @Get(':jobId/items')
  @ApiOperation({ summary: 'Per-opportunity outcomes, e.g. ?outcome=skipped_conflict (paged by seq)' })
  @ApiNotFoundResponse({ description: 'No such job in this workspace.' })
  items(
    @WorkspaceId() workspaceId: string,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Query() query: ItemsQueryDto,
  ) {
    return listItems(this.pool, workspaceId, jobId, query.outcome, query.afterSeq, query.limit);
  }
}
