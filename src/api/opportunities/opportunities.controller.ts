import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Pool } from '../../db/pool.js';
import { PG_POOL } from '../../common/tokens.js';
import { WorkspaceId } from '../../common/workspace.decorator.js';
import {
  createOpportunity,
  listStage,
  listStages,
  moveOpportunity,
  type Page,
  type Stage,
} from '../../engine/opportunities.js';
import type { Opportunity } from '../../engine/rows.js';
import {
  CreateOpportunityDto,
  ListStageQueryDto,
  MoveStageDto,
  OpportunityDto,
  OpportunityPageDto,
  StageDto,
} from './opportunities.dto.js';

const WORKSPACE_HEADER = {
  name: 'X-Workspace-Id',
  required: true,
  description: 'Tenant scope (not authentication). Seeded example: b0000000-0000-4000-8000-000000000001',
} as const;

@ApiTags('opportunities (Part 1)')
@ApiHeader(WORKSPACE_HEADER)
@ApiBadRequestResponse({ description: 'Invalid header, path or body.' })
@Controller('v1')
export class OpportunitiesController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('stages')
  @ApiOperation({ summary: 'List the pipeline stages of this workspace, in order' })
  @ApiOkResponse({ type: [StageDto] })
  stages(@WorkspaceId() workspaceId: string): Promise<Stage[]> {
    return listStages(this.pool, workspaceId);
  }

  @Post('opportunities')
  @ApiOperation({ summary: 'Create an opportunity' })
  @ApiCreatedResponse({ type: OpportunityDto })
  @ApiNotFoundResponse({ description: 'Stage is not in this workspace.' })
  create(@WorkspaceId() workspaceId: string, @Body() body: CreateOpportunityDto): Promise<Opportunity> {
    return createOpportunity(this.pool, workspaceId, body);
  }

  @Patch('opportunities/:id/stage')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Move one opportunity to another stage (records a transition)',
    description:
      'Bumps stageRev. If a bulk move is running over this opportunity, the manual move wins and the ' +
      'job skips it as a conflict. Moving to the current stage is a no-op.',
  })
  @ApiOkResponse({ type: OpportunityDto })
  @ApiNotFoundResponse({ description: 'Opportunity or stage not found in this workspace.' })
  @ApiServiceUnavailableResponse({ description: 'Row stayed locked for over 1 s twice; safe to retry.' })
  move(
    @WorkspaceId() workspaceId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: MoveStageDto,
  ): Promise<Opportunity> {
    return moveOpportunity(this.pool, workspaceId, id, body.stageId);
  }

  @Get('stages/:stageId/opportunities')
  @ApiOperation({ summary: 'List opportunities in a stage (keyset pagination, oldest first)' })
  @ApiOkResponse({ type: OpportunityPageDto })
  @ApiNotFoundResponse({ description: 'Stage not found in this workspace.' })
  list(
    @WorkspaceId() workspaceId: string,
    @Param('stageId', new ParseUUIDPipe({ version: '4' })) stageId: string,
    @Query() query: ListStageQueryDto,
  ): Promise<Page<Opportunity>> {
    return listStage(this.pool, workspaceId, stageId, query.limit, query.cursor);
  }
}
