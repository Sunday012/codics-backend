import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerLimitDetail, ThrottlerRequest } from '@nestjs/throttler';
import type { Response } from 'express';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected override async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { context, throttler } = requestProps;
    const handlerName = context.getHandler()?.name;

    if (throttler.name === 'login' && handlerName !== 'login') {
      return true;
    }
    if (
      throttler.name === 'activate' &&
      !['activate', 'activateVerify', 'activateLookup'].includes(handlerName)
    ) {
      return true;
    }
    if (throttler.name === 'refresh' && handlerName !== 'refresh') {
      return true;
    }

    return super.handleRequest(requestProps);
  }

  protected override async getTracker(
    req: Record<string, any>,
  ): Promise<string> {
    const rawIp = req.ips?.length
      ? req.ips[0]
      : req.ip || req.connection?.remoteAddress || '127.0.0.1';
    if (req.body?.identifier) {
      const identifier = String(req.body.identifier).trim().toLowerCase();
      return `${rawIp}:${identifier}`;
    }
    if (req.body?.matricNo) {
      const matric = String(req.body.matricNo).trim().toLowerCase();
      return `${rawIp}:${matric}`;
    }
    return rawIp;
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((throttlerLimitDetail.timeToExpire || 60000) / 1000),
    );
    response.setHeader('Retry-After', retryAfterSeconds.toString());
    throw new ThrottlerException(
      await this.getErrorMessage(context, throttlerLimitDetail),
    );
  }
}
