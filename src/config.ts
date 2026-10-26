function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid configuration: ${name}`);
  return value;
}
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:55432/wager',
  sqsEndpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  port: positive('PORT', 3000),
  workers: process.env.WORKERS_ENABLED !== 'false',
  referenceMaxAttempts: positive('REFERENCE_MAX_ATTEMPTS', 12),
  referenceBackoffMs: positive('REFERENCE_BACKOFF_MS', 1000),
  outboxBackoffMs: positive('OUTBOX_BACKOFF_MS', 1000),
  visibility: positive('SQS_VISIBILITY_SECONDS', 30),
  maxReceives: positive('SQS_MAX_RECEIVES', 5),
  queue: 'wager-transactions.fifo',
  dlq: 'wager-transactions-dlq.fifo',
  events: 'wager-events.fifo',
};
