import { ensure } from './errors';
import { IntegrationEvent, EventData } from './events';

export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    private _processedAt?: Date,
  ) {}
  static receive(id: string, consumer: string, hash: string) {
    return new InboxMessage(id, consumer, hash);
  }
  static rehydrate(id: string, consumer: string, hash: string, processedAt?: Date) {
    return new InboxMessage(id, consumer, hash, processedAt);
  }
  get processedAt() {
    return this._processedAt;
  }
  isProcessed() {
    return this._processedAt !== undefined;
  }
  markProcessed(at: Date) {
    ensure(!this.isProcessed(), 'INBOX_ALREADY_PROCESSED', 500);
    this._processedAt = at;
  }
}

export class OutboxMessage {
  private constructor(
    readonly payload: ReturnType<IntegrationEvent<EventData>['toJSON']>,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}
  static enqueue(event: IntegrationEvent<EventData>) {
    return new OutboxMessage(event.toJSON(), 0);
  }
  static rehydrate(
    payload: ReturnType<IntegrationEvent<EventData>['toJSON']>,
    attempts: number,
    nextAttemptAt?: Date,
    publishedAt?: Date,
  ) {
    return new OutboxMessage(payload, attempts, nextAttemptAt, publishedAt);
  }
  get attempts() {
    return this._attempts;
  }
  get nextAttemptAt() {
    return this._nextAttemptAt;
  }
  get publishedAt() {
    return this._publishedAt;
  }
  isPending() {
    return !this._publishedAt;
  }
  isDue(now: Date) {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }
  markPublished(at: Date) {
    ensure(this.isPending(), 'OUTBOX_ALREADY_PUBLISHED', 500);
    this._publishedAt = at;
  }
  scheduleRetry(now: Date, baseMs = 1000) {
    this._attempts++;
    this._nextAttemptAt = new Date(
      now.getTime() + Math.min(baseMs * 2 ** Math.min(this._attempts - 1, 16), 60000),
    );
  }
}
