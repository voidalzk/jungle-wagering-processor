import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { WageringService } from '../application/wagering';
import { text } from '../application/contracts';
import { AppError } from '../domain/errors';
import { Queues } from '../messaging/sqs';
import { registry } from '../observability';
import { ProviderAuthGuard } from './auth.guard';

function context(correlation?: string) {
  return { correlationId: correlation ? text(correlation, 'CORRELATION_ID') : randomUUID() };
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class ApiController {
  constructor(@Inject(WageringService) private readonly service: WageringService) {}
  @Post('wallets') open(@Body() body: unknown, @Headers('x-correlation-id') correlation?: string) {
    return this.service.openWallet(body, context(correlation));
  }
  @Get('wallets/:id') wallet(@Param('id') id: string) {
    return this.service.getWallet(id);
  }
  @Get('wallets/:id/ledger') ledger(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.ledger(id, cursor, limit);
  }
  @Get('wagering/transactions/:id') transaction(@Param('id') id: string) {
    return this.service.getTransaction(id);
  }
  @Get('providers/:provider/wagering/transactions/:external') providerTransaction(
    @Param('provider') provider: string,
    @Param('external') external: string,
  ) {
    return this.service.getProviderTransaction(provider, external);
  }
  @Post('wallets/:id/reconciliation') @HttpCode(200) reconciliation(
    @Param('id') id: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.service.reconcile(id, context(correlation));
  }
  @Post('wagering/transactions') async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    const ctx = context(correlation);
    response.setHeader('x-correlation-id', ctx.correlationId);
    const result = await this.service.submit(body, key, ctx);
    response.status(
      result.status === 'REJECTED'
        ? 422
        : result.status === 'FAILED'
          ? 503
          : result.status.startsWith('PENDING')
            ? 202
            : 200,
    );
    return result;
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(WageringService) private readonly service: WageringService,
    @Inject(Queues) private readonly queues: Queues,
  ) {}
  @Get('health/live') live() {
    return { status: 'up' };
  }
  @Get('health/ready') async ready() {
    try {
      await Promise.all([this.service.db.query('SELECT 1'), this.queues.ready()]);
      return { status: 'ready' };
    } catch {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 503);
    }
  }
  @Get('metrics') async metrics(@Res() response: Response) {
    response.type(registry.contentType).send(await registry.metrics());
  }
}
