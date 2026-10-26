import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
const options = { registers: [registry] };
export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Committed transaction transitions',
    labelNames: ['status'],
    ...options,
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_total',
    help: 'Idempotent replays',
    ...options,
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Scheduled retries',
    labelNames: ['source'],
    ...options,
  }),
  dlq: new Counter({ name: 'wager_dlq_total', help: 'Messages routed to DLQ', ...options }),
  lockConflicts: new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Lock timeouts and deadlocks',
    ...options,
  }),
  outboxLag: new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Age of oldest unpublished event',
    ...options,
  }),
  latency: new Histogram({
    name: 'wager_processing_seconds',
    help: 'Transaction processing latency',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    ...options,
  }),
  reconciliation: new Counter({
    name: 'wager_reconciliation_mismatches_total',
    help: 'Ledger discrepancies',
    ...options,
  }),
};
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  code?: string;
  status?: string;
}
export function log(
  level: 'info' | 'error' | 'warn',
  message: string,
  context: LogContext = {},
): void {
  if (process.env.LOG_LEVEL === 'silent') return;
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      correlationId: context.correlationId ?? null,
      messageId: context.messageId ?? null,
      transactionId: context.transactionId ?? null,
      walletId: context.walletId ?? null,
      providerId: context.providerId ?? null,
      code: context.code,
      status: context.status,
    }),
  );
}
