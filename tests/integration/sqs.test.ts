import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { Queues } from '../../src/messaging/sqs';
import { Workers } from '../../src/messaging/workers';
import { config } from '../../src/config';
import { createDatabase } from '../../src/persistence/database';
import { WageringService } from '../../src/application/wagering';
import {
  db,
  service,
  ctx,
  initialize,
  open,
  wager,
  consistent,
  eventually,
} from '../support/database';

const enabled = process.env.TEST_SQS === 'true';
const queues = new Queues();
const worker = new Workers(service, queues);
const envelope = (input: ReturnType<typeof wager>, id = randomUUID()) => ({
  messageId: id,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { ...input, idempotencyKey: `${input.providerId}:${input.externalTransactionId}` },
});

describe.skipIf(!enabled)('SQS compatível via emulador', () => {
  beforeAll(async () => {
    await initialize();
    const setup = Bun.spawn([process.execPath, 'scripts/queues.ts'], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await setup.exited).toBe(0);
    // Executar somente no ambiente de teste dedicado: estas filas não são de produção.
    for (const name of [config.queue, config.dlq, config.events])
      await queues.client.send(new PurgeQueueCommand({ QueueUrl: await queues.url(name) }));
  });
  afterAll(async () => {
    queues.close();
    if (db.isInitialized) await db.destroy();
  });

  test('consumo e redelivery com outro deduplicationId usam inbox persistente', async () => {
    const wallet = await open();
    const event = envelope(wager(wallet));
    await queues.send(config.queue, JSON.stringify(event), wallet.id, randomUUID());
    await worker.consume();
    await queues.send(config.queue, JSON.stringify(event), wallet.id, randomUUID());
    await worker.consume();
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('90.00');
    const [row] = await db.query('SELECT count(*)::int AS total FROM inbox WHERE message_id=$1', [
      event.messageId,
    ]);
    expect(row.total).toBe(1);
  });
  test('payload permanente vai para DLQ e é removido da fila de entrada', async () => {
    await queues.send(config.queue, '{"invalid":true}', randomUUID(), randomUUID());
    await worker.consume();
    const messages = await queues.receive(config.dlq);
    expect(messages.some((m) => m.Body === '{"invalid":true}')).toBe(true);
    for (const message of messages) await queues.ack(config.dlq, message);
  });
  test('indisponibilidade transitória gera retry e o limite encaminha à DLQ', async () => {
    const wallet = await open();
    const event = envelope(wager(wallet));
    const unavailable = createDatabase(config.databaseUrl.replace(/:\d+\//, ':1/'));
    // DataSource sem conexão reproduz indisponibilidade real do recurso, sem mock de SQS.
    const retryWorker = new Workers(new WageringService(unavailable), queues);
    await queues.send(config.queue, JSON.stringify(event), wallet.id, randomUUID());
    for (let attempt = 1; attempt <= config.maxReceives; attempt++) {
      const messages = await eventually(
        () => queues.receive(config.queue),
        (rows) => rows.length > 0,
        120000,
      );
      await retryWorker.handle(messages[0]!);
    }
    const dead = await eventually(
      () => queues.receive(config.dlq),
      (rows) => rows.some((m) => JSON.parse(m.Body!).messageId === event.messageId),
    );
    for (const message of dead) await queues.ack(config.dlq, message);
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('100.00');
  });
  test('dois publishers concorrentes não perdem eventos confirmados', async () => {
    const wallet = await open();
    await service.submit(wager(wallet), randomUUID(), ctx());
    const other = new Workers(service, queues);
    await eventually(
      async () => {
        await Promise.all([worker.publish(), other.publish()]);
        const [row] = await db.query(
          'SELECT count(*)::int AS pending FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',
          [wallet.id],
        );
        return row.pending;
      },
      (n) => n === 0,
      120000,
    );
    const rows = await db.query('SELECT id,published_at FROM outbox WHERE aggregate_id=$1', [
      wallet.id,
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.every((r: { published_at: Date | null }) => r.published_at)).toBe(true);
    await consistent(wallet.id);
  });
  test('worker morre depois do commit e antes do ack; redelivery não repete débito', async () => {
    const wallet = await open();
    const event = envelope(wager(wallet));
    await queues.send(config.queue, JSON.stringify(event), wallet.id, randomUUID());
    const child = Bun.spawn([process.execPath, 'tests/support/crash-consumer.ts'], {
      env: { ...process.env, NODE_ENV: 'test', TEST_CRASH_AFTER_COMMIT: event.messageId },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    try {
      expect(await child.exited).toBe(86);
    } finally {
      if (child.exitCode === null) child.kill();
    }
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('90.00');
    const messages = await eventually(
      () => queues.receive(config.queue),
      (rows) => rows.length > 0,
      60000,
    );
    await worker.handle(messages[0]!);
    expect((await consistent(wallet.id)).checkedEntries).toBe(2);
    expect(await queues.receive(config.queue)).toHaveLength(0);
  });
  test('publisher morre após enviar; nova instância retoma a outbox sem perder evento', async () => {
    const wallet = await open();
    const child = Bun.spawn([process.execPath, 'tests/support/crash-consumer.ts'], {
      env: { ...process.env, NODE_ENV: 'test', TEST_CRASH_AFTER_PUBLISH: 'true' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    try {
      expect(await child.exited).toBe(87);
    } finally {
      if (child.exitCode === null) child.kill();
    }
    await eventually(
      async () => {
        await worker.publish();
        const [row] = await db.query(
          'SELECT count(*)::int AS pending FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',
          [wallet.id],
        );
        return row.pending;
      },
      (n) => n === 0,
      120000,
    );
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('100.00');
  });
});
