/**
 * Request/response shapes for Part 1. class-validator rules run in the global ValidationPipe
 * (whitelist + forbidNonWhitelisted, so unknown fields are a 400), and the same decorators
 * generate the Swagger docs at /docs.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from '../../engine/rows.js';

export class CreateOpportunityDto {
  @ApiProperty({ example: 'Acme renewal', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: 2500000, description: 'Deal value in cents (integer, never a float).' })
  @IsInt()
  @Min(0)
  @Max(1e15)
  valueCents!: number;

  @ApiProperty({ enum: OPPORTUNITY_STATUSES, example: 'open' })
  @IsIn(OPPORTUNITY_STATUSES)
  status!: OpportunityStatus;

  @ApiProperty({ example: 'owner-7', minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100)
  ownerId!: string;

  @ApiProperty({ format: 'uuid', description: 'Stage in this workspace.' })
  @IsUUID('4')
  stageId!: string;
}

export class MoveStageDto {
  @ApiProperty({ format: 'uuid', description: 'Destination stage in this workspace.' })
  @IsUUID('4')
  stageId!: string;
}

export class ListStageQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page\'s nextCursor.' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  cursor?: string;
}

export class OpportunityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) stageId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() valueCents!: number;
  @ApiProperty({ enum: OPPORTUNITY_STATUSES }) status!: OpportunityStatus;
  @ApiProperty() ownerId!: string;
  @ApiProperty({ description: 'Incremented on every stage change (used to detect concurrent edits).' })
  stageRev!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class OpportunityPageDto {
  @ApiProperty({ type: [OpportunityDto] }) data!: OpportunityDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class StageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Qualified' }) name!: string;
  @ApiProperty({ example: 2 }) position!: number;
}
