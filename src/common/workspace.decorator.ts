import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { isUUID } from 'class-validator';

/**
 * Reads the tenant from the X-Workspace-Id header. The workspace never comes from the
 * body or the path, so a client cannot address another tenant's data by editing JSON.
 * Not authentication (out of scope): it only scopes every query.
 */
export const WorkspaceId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const value = request.header('x-workspace-id');
  if (!value || !isUUID(value, '4')) {
    throw new BadRequestException('X-Workspace-Id header must be a UUID');
  }
  return value.toLowerCase();
});
