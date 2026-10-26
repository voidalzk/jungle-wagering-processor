import { Message } from '@aws-sdk/client-sqs';
import { WageringService } from '../application/wagering';
import { object, parseWager, payloadHash, text } from '../application/contracts';
import { config } from '../config';
import { AppError, ensure } from '../domain/errors';
import { OutboxMessage } from '../domain/messages';
import { EventData, IntegrationEvent } from '../domain/events';
import { log, metrics } from '../observability';
import { Queues } from './sqs';
import { sqlCode } from '../persistence/database';

export class Workers {
  private running = false;
  private tasks: Promise<void>[] = [];
  constructor(
    readonly service: WageringService,
    readonly queues: Queues,
  ) {}
  start(): void {
    this.running = true;
    this.tasks = [
      this.loop(() => this.consume(), 100),
      this.loop(() => this.publish(), 250),
      this.loop(() => this.service.retryReferences(), 500),
    ];
  }
  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.tasks);
  }
  private async loop(work: () => Promise<unknown>, delay: number): Promise<void> {
    while (this.running) {
      try {
        await work();
      } catch (error) {
        log('error', 'worker_iteration_failed', {
          code: error instanceof AppError ? error.code : 'INFRASTRUCTURE_UNAVAILABLE',
        });
      }
      if (this.running) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  async consume(): Promise<void> {
    const messages = await this.queues.receive(config.queue);
    for (const message of messages) await this.handle(message);
  }
  async handle(message: Message): Promise<void> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let envelope: Record<string, unknown> | undefined;
    try {
      try {
        envelope = object(JSON.parse(message.Body ?? ''));
      } catch {
        throw new AppError('INVALID_ENVELOPE', 400);
      }
      ensure(envelope.type === 'WagerTransactionRequested', 'INVALID_EVENT_TYPE', 400);
      const messageId = text(envelope.messageId, 'MESSAGE_ID');
      ensure(
        typeof envelope.occurredAt === 'string' && Number.isFinite(Date.parse(envelope.occurredAt)),
        'INVALID_EVENT_DATE',
        400,
      );
      const data = object(envelope.data);
      const p = parseWager(data);
      const key = text(data.idempotencyKey, 'IDEMPOTENCY_KEY');
      heartbeat = setInterval(
        () => {
          void this.queues
            .visibility(config.queue, message, config.visibility)
            .catch(() => log('warn', 'visibility_extension_failed', { messageId }));
        },
        Math.max(1000, Math.floor((config.visibility * 1000) / 3)),
      );
      await this.service.submit(p, key, {
        correlationId: messageId,
        causationId: messageId,
        messageId,
        inboxHash: payloadHash({ business: p, idempotencyKey: key }),
      });
      // Ponto de falha usado somente pelo teste de recuperação após commit.
      if (process.env.NODE_ENV === 'test' && process.env.TEST_CRASH_AFTER_COMMIT === messageId)
        process.exit(86);
      await this.queues.ack(config.queue, message);
    } catch (error) {
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const invalid = error instanceof AppError && [400, 404, 409].includes(error.httpStatus);
      const permanent =
        invalid || ['23514', '42P01', '42703', '42883'].includes(sqlCode(error) ?? '');
      if (permanent || attempts >= config.maxReceives) {
        if (!invalid && envelope) {
          try {
            const data = object(envelope.data);
            await this.service.recordInfrastructureFailure(
              data,
              text(data.idempotencyKey, 'IDEMPOTENCY_KEY'),
              { correlationId: String(envelope.messageId), messageId: String(envelope.messageId) },
              permanent ? 'PERMANENT_INFRASTRUCTURE_ERROR' : 'INFRASTRUCTURE_RETRY_EXHAUSTED',
            );
          } catch {
            log('error', 'failure_audit_unavailable_dlq_retains_message', {
              messageId: message.MessageId,
            });
          }
        }
        await this.queues.send(
          config.dlq,
          message.Body ?? '{}',
          message.MessageId ?? 'invalid',
          `dlq:${message.MessageId}`,
        );
        await this.queues.ack(config.queue, message);
        metrics.dlq.inc();
        log('warn', 'message_sent_to_dlq', {
          messageId:
            typeof envelope?.messageId === 'string' ? envelope.messageId : message.MessageId,
          code: error instanceof AppError ? error.code : 'INFRASTRUCTURE_RETRY_EXHAUSTED',
        });
      } else {
        metrics.retries.inc({ source: 'sqs' });
        await this.queues.visibility(
          config.queue,
          message,
          Math.min(2 ** Math.min(attempts, 8), 300),
        );
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  async publish(): Promise<number> {
    let published = 0;
    await this.service.db.transaction(async (em) => {
      // O lock é apenas nas mensagens selecionadas; outros publishers pegam outro lote.
      const rows: {
        id: string;
        payload: ReturnType<IntegrationEvent<EventData>['toJSON']>;
        attempts: number;
        next_attempt_at: Date;
      }[] = await em.query(
        'SELECT * FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now() ORDER BY occurred_at,id LIMIT 10 FOR UPDATE SKIP LOCKED',
      );
      for (const row of rows) {
        const outbox = OutboxMessage.rehydrate(row.payload, row.attempts, row.next_attempt_at);
        try {
          await this.queues.send(
            config.events,
            JSON.stringify(row.payload),
            row.payload.aggregateId,
            row.id,
          );
          if (process.env.NODE_ENV === 'test' && process.env.TEST_CRASH_AFTER_PUBLISH === 'true')
            process.exit(87);
          outbox.markPublished(new Date());
          await em.query('UPDATE outbox SET published_at=$2 WHERE id=$1', [
            row.id,
            outbox.publishedAt,
          ]);
          published++;
        } catch {
          outbox.scheduleRetry(new Date(), config.outboxBackoffMs);
          await em.query('UPDATE outbox SET attempts=$2,next_attempt_at=$3 WHERE id=$1', [
            row.id,
            outbox.attempts,
            outbox.nextAttemptAt,
          ]);
          metrics.retries.inc({ source: 'outbox' });
        }
      }
    });
    const [lag] = await this.service.db.query(
      'SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(occurred_at)),0)::float AS seconds FROM outbox WHERE published_at IS NULL',
    );
    metrics.outboxLag.set(Math.max(0, lag.seconds));
    return published;
  }
}
