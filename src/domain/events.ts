import { randomUUID } from 'node:crypto';

export interface EventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  readonly version = 1;
  protected constructor(readonly props: EventProps<T>) {
    Object.freeze(props.data);
    Object.freeze(props);
  }
  toJSON() {
    return {
      eventId: this.props.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.props.aggregateId,
      correlationId: this.props.correlationId,
      causationId: this.props.causationId,
      occurredAt: this.props.occurredAt.toISOString(),
      data: this.props.data,
    };
  }
}
export type EventData = Record<string, unknown>;
export interface EventContext {
  correlationId: string;
  causationId?: string;
}
function props(aggregateId: string, data: EventData, ctx: EventContext): EventProps<EventData> {
  return { eventId: randomUUID(), aggregateId, data, ...ctx, occurredAt: new Date() };
}
export class WagerTransactionProcessed extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionProcessed';
  static from(id: string, data: EventData, ctx: EventContext) {
    return new this(props(id, data, ctx));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionRejected';
  static from(id: string, data: EventData, ctx: EventContext) {
    return new this(props(id, data, ctx));
  }
}
export class WagerTransactionFailed extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionFailed';
  static from(id: string, data: EventData, ctx: EventContext) {
    return new this(props(id, data, ctx));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  static from(id: string, data: EventData, ctx: EventContext) {
    return new this(props(id, data, ctx));
  }
}
export class WalletBalanceChanged extends IntegrationEvent<EventData> {
  readonly eventType = 'WalletBalanceChanged';
  static from(id: string, data: EventData, ctx: EventContext) {
    return new this(props(id, data, ctx));
  }
}
