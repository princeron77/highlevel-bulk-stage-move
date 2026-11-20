/**
 * Request/response shapes for bulk moves. Limits here are the first line of defence against
 * adversarial input: unknown fields, non-UUID ids, absurd numbers and bad dates are rejected
 * with a 400 before any SQL runs. Filter semantics are documented on each field.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from '../../engine/rows.js';

export class BulkFilterDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only opportunities currently in this stage.' })
  @IsOptional() @IsUUID('4') stageId?: string;

  @ApiPropertyOptional({ example: 'owner-7' })
  @IsOptional() @IsString() @Length(1, 100) ownerId?: string;

  @ApiPropertyOptional({ enum: OPPORTUNITY_STATUSES })
  @IsOptional() @IsIn(OPPORTUNITY_STATUSES) status?: OpportunityStatus;

  @ApiPropertyOptional({ description: 'Inclusive, in cents.' })
  @IsOptional() @IsInt() @Min(0) @Max(1e15) minValueCents?: number;

  @ApiPropertyOptional({ description: 'Inclusive, in cents.' })
  @IsOptional() @IsInt() @Min(0) @Max(1e15) maxValueCents?: number;

  @ApiPropertyOptional({ format: 'date-time', description: 'created_at >= createdFrom' })
  @IsOptional() @IsISO8601({ strict: true }) createdFrom?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'created_at < createdTo' })
  @IsOptional() @IsISO8601({ strict: true }) createdTo?: string;
}

export class SubmitBulkMoveDto {
  @ApiProperty({ format: 'uuid', description: 'Stage every matching opportunity is moved to.' })
  @IsUUID('4')
  targetStageId!: string;

  @ApiProperty({ type: BulkFilterDto, description: 'All given fields must match (AND). Max 50,000 matches.' })
  @IsDefined()
  @ValidateNested()
  @Type(() => BulkFilterDto)
  filter!: BulkFilterDto;
}

export class SubmitBulkMoveResponseDto {
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ description: 'true when this exact request had already been accepted (no new job was created).' })
  replayed!: boolean;
  @ApiProperty({ example: '/v1/bulk-moves/5b6c…' }) progressUrl!: string;
}

export class ItemsQueryDto {
  @ApiPropertyOptional({ enum: ['moved', 'skipped_conflict', 'skipped_noop', 'pending'] })
  @IsOptional() @IsIn(['moved', 'skipped_conflict', 'skipped_noop', 'pending']) outcome?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) afterSeq: number = 0;

  @ApiPropertyOptional({ default: 100, maximum: 1000 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit: number = 100;
}

class CountsDto {
  @ApiProperty() moved!: number;
  @ApiProperty({ description: 'Skipped because the opportunity changed stage after submit (manual edit wins).' })
  skippedConflict!: number;
  @ApiProperty({ description: 'Skipped because it was already in the target stage.' })
  skippedNoop!: number;
  @ApiProperty() pending!: number;
}

export class JobProgressDto {
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ enum: ['queued', 'processing', 'completed', 'failed'] }) status!: string;
  @ApiProperty({
    enum: ['queued', 'running', 'throttled', 'waiting', 'retrying', 'stalled', 'done', 'failed'],
    description:
      'running/throttled/waiting = progressing (throttled and waiting are slow on purpose), ' +
      'retrying = transient error with backoff, stalled = a worker died holding the job and nobody took it over, or no progress for 5 min (stuck), failed = gave up.',
  })
  health!: string;
  @ApiProperty({ format: 'uuid' }) targetStageId!: string;
  @ApiProperty({ type: Object }) filter!: unknown;
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'Committed items. Never moves backwards, survives restarts.' }) processed!: number;
  @ApiProperty({ example: 61.2 }) percent!: number;
  @ApiProperty({ type: CountsDto }) counts!: CountsDto;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: String }) lastError!: string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) nextAttemptAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastProgressAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) heartbeatAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finishedAt!: string | null;
}
