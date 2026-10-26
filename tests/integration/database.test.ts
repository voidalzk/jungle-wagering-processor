import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Initial1760000000000 } from '../../src/persistence/migrations/initial';
import { createDatabase } from '../../src/persistence/database';
import { WageringService } from '../../src/application/wagering';
import { db, service, ctx, initialize, open, wager, submit, consistent } from '../support/database';

beforeAll(initialize);
afterAll(async () => {
  if (db.isInitialized) await db.destroy();
});

describe('Banco real e invariantes', () => {
  test('migration sobe, reverte e sobe novamente em schema isolado', async () => {
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`CREATE SCHEMA ${schema}`);
      await runner.query(`SET LOCAL search_path TO ${schema}`);
      const migration = new Initial1760000000000();
      await migration.up(runner);
      await migration.down(runner);
      await migration.up(runner);
      const rows = await runner.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [
        schema,
      ]);
      expect(rows).toHaveLength(5);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
  test('abertura gera ledger e versão 1; abertura zerada não gera lançamento', async () => {
    const wallet = await open();
    const zero = await open('0.00');
    expect(wallet.version).toBe(1);
    expect((await consistent(wallet.id)).checkedEntries).toBe(1);
    expect((await consistent(zero.id)).checkedEntries).toBe(0);
    await expect(
      service.openWallet({ playerId: wallet.playerId, initialBalance: wallet.balance }, ctx()),
    ).rejects.toThrow('DUPLICATE_RESOURCE');
  });
  test('50 requisições simultâneas causam somente um débito', async () => {
    const wallet = await open();
    const input = wager(wallet);
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(input)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect((await consistent(wallet.id)).checkedEntries).toBe(2);
    const [count] = await db.query(
      'SELECT count(*)::int AS total FROM outbox WHERE aggregate_id=$1',
      [wallet.id],
    );
    expect(count.total).toBe(4);
  });
  test('duas apostas de 80 disputando 100: uma aprovada, outra rejeitada', async () => {
    const wallet = await open();
    const results = await Promise.all([
      submit(wager(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
      submit(wager(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
    expect((await consistent(wallet.id)).checkedEntries).toBe(2);
  });
  test('wallets independentes processam em paralelo', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => open()));
    await Promise.all(wallets.map((w) => submit(wager(w))));
    for (const w of wallets) expect((await consistent(w.id)).storedBalance.amount).toBe('90.00');
  });
  test('replay mantém saldo original e conflito não movimenta carteira', async () => {
    const wallet = await open();
    const input = wager(wallet);
    const original = await submit(input);
    await submit(wager(wallet));
    const replay = await submit(input);
    expect(replay.balance).toEqual(original.balance);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('80.00');
    await expect(submit({ ...input, money: { amount: '11.00', currency: 'BRL' } })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    await expect(submit(input, 'another-key')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const other = await open();
    await expect(
      submit(wager(other), `${input.providerId}:${input.externalTransactionId}`),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await consistent(wallet.id);
    await consistent(other.id);
  });
  test('WIN, LOSS, REFUND e ROLLBACK preservam ledger e versão', async () => {
    const wallet = await open();
    const bet = wager(wallet);
    await submit(bet);
    const win = wager(wallet, {
      kind: 'WIN',
      money: { amount: '20.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submit(win);
    const beforeLoss = await service.getWallet(wallet.id);
    expect(
      (await submit(wager(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } })))
        .status,
    ).toBe('PROCESSED');
    expect((await service.getWallet(wallet.id)).version).toBe(beforeLoss.version);
    const refund = wager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submit(refund)).balance.amount).toBe('120.00');
    expect(
      (
        await submit(
          wager(wallet, {
            kind: 'REFUND',
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        )
      ).failureCode,
    ).toBe('REFERENCE_ALREADY_REVERSED');
    expect(
      (
        await submit(
          wager(wallet, {
            kind: 'ROLLBACK',
            referenceExternalTransactionId: win.externalTransactionId,
            money: win.money,
          }),
        )
      ).balance.amount,
    ).toBe('100.00');
    expect((await consistent(wallet.id)).checkedEntries).toBe(5);
  });
  test('reversão sem saldo tem falha distinta e permanece auditável', async () => {
    const wallet = await open('0.00');
    const win = wager(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await submit(win);
    await submit(wager(wallet, { money: win.money }));
    const rejected = await submit(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: win.externalTransactionId,
        money: win.money,
      }),
    );
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('0.00');
  });
  test('contexto, moeda, valor e tipo de referência são validados', async () => {
    const wallet = await open();
    const bet = wager(wallet);
    await submit(bet);
    expect(
      (await submit(wager(wallet, { money: { amount: '10.00', currency: 'USD' } }))).failureCode,
    ).toBe('CURRENCY_MISMATCH');
    expect((await submit(wager(wallet, { playerId: randomUUID() }))).failureCode).toBe(
      'PLAYER_MISMATCH',
    );
    expect(
      (
        await submit(
          wager(wallet, {
            kind: 'REFUND',
            roundId: 'different',
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        )
      ).failureCode,
    ).toBe('REFERENCE_CONTEXT_MISMATCH');
    expect(
      (
        await submit(
          wager(wallet, {
            kind: 'REFUND',
            money: { amount: '1.00', currency: 'BRL' },
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        )
      ).failureCode,
    ).toBe('REFERENCE_AMOUNT_MISMATCH');
    await consistent(wallet.id);
  });
  test.each(['REFUND', 'ROLLBACK'] as const)(
    '%s antes da referência é retomado por worker',
    async (kind) => {
      const wallet = await open();
      const bet = wager(wallet);
      const pending = await submit(
        wager(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId }),
      );
      expect(pending.status).toBe('PENDING_REFERENCE');
      await submit(bet);
      await db.query(
        "UPDATE transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [pending.transactionId],
      );
      await service.retryReferences();
      expect((await service.getTransaction(pending.transactionId)).status).toBe('PROCESSED');
      expect((await consistent(wallet.id)).storedBalance.amount).toBe('100.00');
    },
  );
  test('referência expira com rejeição persistida e evento', async () => {
    const wallet = await open();
    const pending = await submit(
      wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() }),
    );
    await db.query(
      "UPDATE transactions SET attempts=100,next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [pending.transactionId],
    );
    await service.retryReferences();
    expect((await service.getTransaction(pending.transactionId)) as object).toHaveProperty(
      'failureCode',
      'REFERENCE_EXPIRED',
    );
    expect((await consistent(wallet.id)).checkedEntries).toBe(1);
  });
  test('inbox deduplica redelivery e recusa reutilização de messageId', async () => {
    const wallet = await open();
    const input = wager(wallet);
    const messageId = randomUUID();
    const key = randomUUID();
    await service.submit(input, key, { ...ctx(), messageId });
    expect((await service.submit(input, key, { ...ctx(), messageId })).idempotentReplay).toBe(true);
    await expect(
      service.submit(wager(wallet), randomUUID(), { ...ctx(), messageId }),
    ).rejects.toThrow('INBOX_CONFLICT');
    const [inbox] = await db.query('SELECT count(*)::int AS total FROM inbox WHERE message_id=$1', [
      messageId,
    ]);
    expect(inbox.total).toBe(1);
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('90.00');
  });
  test('falha na outbox reverte saldo, transação, ledger e inbox juntos', async () => {
    const wallet = await open();
    const name = `fail_${randomUUID().replaceAll('-', '')}`;
    await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.aggregate_id='${wallet.id}'::uuid THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${name}();`);
    const input = wager(wallet);
    const messageId = randomUUID();
    try {
      await expect(service.submit(input, randomUUID(), { ...ctx(), messageId })).rejects.toThrow();
    } finally {
      await db.query(`DROP TRIGGER ${name} ON outbox; DROP FUNCTION ${name}();`);
    }
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('100.00');
    expect(
      await db.query('SELECT id FROM transactions WHERE external_id=$1', [
        input.externalTransactionId,
      ]),
    ).toHaveLength(0);
    expect(
      await db.query('SELECT message_id FROM inbox WHERE message_id=$1', [messageId]),
    ).toHaveLength(0);
  });
  test('schema recusa saldo negativo, divergência, ledger alterado e estado terminal alterado', async () => {
    const wallet = await open();
    const tx = await submit(wager(wallet));
    await expect(
      db.query('UPDATE wallets SET balance=-1 WHERE id=$1', [wallet.id]),
    ).rejects.toThrow();
    await expect(
      db.query('UPDATE wallets SET balance=91 WHERE id=$1', [wallet.id]),
    ).rejects.toThrow();
    await expect(
      db.query('UPDATE ledger SET amount=1 WHERE wallet_id=$1', [wallet.id]),
    ).rejects.toThrow();
    await expect(db.query('DELETE FROM ledger WHERE wallet_id=$1', [wallet.id])).rejects.toThrow();
    await expect(
      db.query("UPDATE transactions SET status='PENDING' WHERE id=$1", [tx.transactionId]),
    ).rejects.toThrow();
    await consistent(wallet.id);
  });
  test('cursor não perde lançamentos e nova conexão reconstrói o mesmo saldo', async () => {
    const wallet = await open();
    await submit(wager(wallet));
    await submit(wager(wallet));
    const first = await service.ledger(wallet.id, undefined, '2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.ledger(wallet.id, first.nextCursor!, '2');
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    const otherDb = await createDatabase().initialize();
    try {
      expect((await new WageringService(otherDb).reconcile(wallet.id, ctx())).consistent).toBe(
        true,
      );
    } finally {
      await otherDb.destroy();
    }
  });
  test('falha permanente é auditável e não desfaz um sucesso anterior', async () => {
    const wallet = await open();
    const input = wager(wallet);
    const key = randomUUID();
    await service.recordInfrastructureFailure(
      input,
      key,
      { ...ctx(), messageId: randomUUID() },
      'PERMANENT_INFRASTRUCTURE_ERROR',
    );
    const failed = await submit(input, key);
    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBe('PERMANENT_INFRASTRUCTURE_ERROR');
    expect((await consistent(wallet.id)).storedBalance.amount).toBe('100.00');
    const other = wager(wallet);
    const otherKey = randomUUID();
    const success = await submit(other, otherKey);
    await service.recordInfrastructureFailure(
      other,
      otherKey,
      ctx(),
      'INFRASTRUCTURE_RETRY_EXHAUSTED',
    );
    expect((await service.getTransaction(success.transactionId)).status).toBe('PROCESSED');
    await consistent(wallet.id);
  });
});
