import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AppError, ensure } from '../domain/errors';
import {
  EventContext,
  IntegrationEvent,
  EventData,
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WagerTransactionFailed,
} from '../domain/events';
import { WalletLedgerEntry } from '../domain/ledger';
import { InboxMessage, OutboxMessage } from '../domain/messages';
import { Money } from '../domain/money';
import { WagerTransaction } from '../domain/transaction';
import { Wallet } from '../domain/wallet';
import { config } from '../config';
import { log, metrics } from '../observability';
import { sqlCode } from '../persistence/database';
import {
  Result,
  TransactionRow,
  TransactionSchema,
  WalletRow,
  WalletSchema,
} from '../persistence/entities';
import { moneyInput, object, parseWager, payloadHash, text, uuid, WagerInput } from './contracts';

export interface RequestContext extends EventContext {
  messageId?: string;
  inboxHash?: string;
}
const consumerName = 'wagering-v1';

export class WageringService {
  constructor(readonly db: DataSource) {}

  private async transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (em) => {
        await em.query("SET LOCAL lock_timeout = '5s'");
        return work(em);
      });
    } catch (error) {
      if (['55P03', '40P01', '40001'].includes(sqlCode(error) ?? '')) {
        metrics.lockConflicts.inc();
        throw new AppError('CONCURRENCY_RETRY', 503);
      }
      if (sqlCode(error) === '23505') throw new AppError('DUPLICATE_RESOURCE', 409);
      throw error;
    }
  }

  async openWallet(input: unknown, ctx: EventContext): Promise<ReturnType<Wallet['toJSON']>> {
    const p = object(input);
    const playerId = uuid(p.playerId);
    const initial = moneyInput(p.initialBalance);
    const wallet = Wallet.open(randomUUID(), playerId, initial);
    return this.transaction(async (em) => {
      await em
        .getRepository(WalletSchema)
        .insert({
          id: wallet.id,
          player_id: playerId,
          currency: initial.currency,
          balance: initial.toString(),
          version: 1,
        });
      if (initial.isPositive()) {
        const tx = WagerTransaction.create({
          id: randomUUID(),
          walletId: wallet.id,
          playerId,
          providerId: '__internal__',
          externalTransactionId: wallet.id,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash: payloadHash(wallet.toJSON()),
          roundId: '__opening__',
          gameId: '__opening__',
          kind: 'OPENING',
          money: initial,
        });
        const business = {
          providerId: '__internal__',
          externalTransactionId: wallet.id,
          playerId,
          walletId: wallet.id,
          roundId: '__opening__',
          gameId: '__opening__',
          kind: 'OPENING',
          money: initial.toJSON(),
        };
        await em.query(
          `INSERT INTO transactions(id,wallet_id,provider_id,external_id,idempotency_key,payload_hash,kind,amount,currency,input,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')`,
          [
            tx.props.id,
            wallet.id,
            tx.props.providerId,
            wallet.id,
            tx.props.idempotencyKey,
            tx.props.payloadHash,
            'OPENING',
            initial.toString(),
            initial.currency,
            business,
          ],
        );
        tx.markProcessed();
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: tx.props.id,
          direction: 'CREDIT',
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: initial,
          createdAt: new Date(),
        });
        await this.insertLedger(em, entry);
        await this.saveResult(em, tx, wallet, ctx);
        await this.enqueue(
          em,
          WalletBalanceChanged.from(wallet.id, this.balanceEvent(wallet, entry), ctx),
        );
      }
      return wallet.toJSON();
    });
  }

  async submit(input: unknown, key: unknown, ctx: RequestContext): Promise<Result> {
    const p = parseWager(input);
    const idempotencyKey = text(key, 'IDEMPOTENCY_KEY');
    ensure(
      p.providerId !== '__internal__' && !idempotencyKey.startsWith('opening:'),
      'RESERVED_PROVIDER',
      400,
    );
    const hash = payloadHash(p);
    const stop = metrics.latency.startTimer();
    try {
      const result = await this.transaction(async (em) => {
        const wallet = await this.lockWallet(em, p.walletId);
        // A carteira é o único ponto de serialização das operações financeiras.
        await em.query(
          `INSERT INTO transactions(id,wallet_id,provider_id,external_id,idempotency_key,payload_hash,kind,amount,currency,input,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING') ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            p.walletId,
            p.providerId,
            p.externalTransactionId,
            idempotencyKey,
            hash,
            p.kind,
            p.money.amount,
            p.money.currency,
            p,
          ],
        );
        const rows: TransactionRow[] = await em.query(
          `SELECT * FROM transactions WHERE idempotency_key=$1 OR (provider_id=$2 AND external_id=$3)`,
          [idempotencyKey, p.providerId, p.externalTransactionId],
        );
        ensure(rows.length === 1, 'IDEMPOTENCY_CONFLICT', 409);
        const row = rows[0]!;
        ensure(
          row.idempotency_key === idempotencyKey && row.payload_hash === hash,
          'IDEMPOTENCY_CONFLICT',
          409,
        );
        let response: Result;
        if (row.result) response = { ...row.result, idempotentReplay: true };
        else response = await this.apply(em, this.rehydrate(row), wallet, ctx, row.attempts);
        if (ctx.messageId)
          await this.recordInbox(em, row.id, ctx, payloadHash({ business: p, idempotencyKey }));
        return response;
      });
      if (result.idempotentReplay) metrics.duplicates.inc();
      else metrics.transactions.inc({ status: result.status });
      log('info', 'transaction_committed', {
        ...ctx,
        transactionId: result.transactionId,
        walletId: p.walletId,
        providerId: p.providerId,
        status: result.status,
      });
      return result;
    } finally {
      stop();
    }
  }

  private async apply(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
    attempts: number,
  ): Promise<Result> {
    let reference: WagerTransaction | undefined;
    let entry: WalletLedgerEntry | undefined;
    try {
      ensure(tx.props.playerId === wallet.playerId, 'PLAYER_MISMATCH');
      ensure(tx.props.money.currency === wallet.balance.currency, 'CURRENCY_MISMATCH');
      if (tx.props.referenceExternalTransactionId) {
        const row = await em
          .getRepository(TransactionSchema)
          .findOneBy({
            provider_id: tx.props.providerId,
            external_id: tx.props.referenceExternalTransactionId,
          });
        if (!row || ['PENDING', 'PENDING_REFERENCE'].includes(row.status)) {
          if (attempts >= config.referenceMaxAttempts) tx.reject('REFERENCE_EXPIRED');
          else {
            const first = tx.status === 'PENDING';
            tx.markPendingReference();
            const delay = Math.min(config.referenceBackoffMs * 2 ** Math.min(attempts, 16), 60000);
            await em.query('UPDATE transactions SET attempts=$2,next_attempt_at=$3 WHERE id=$1', [
              tx.props.id,
              attempts + 1,
              new Date(Date.now() + delay),
            ]);
            if (first)
              await this.enqueue(
                em,
                WagerTransactionPendingReference.from(
                  wallet.id,
                  { transactionId: tx.props.id },
                  ctx,
                ),
              );
          }
          return this.saveResult(em, tx, wallet, ctx);
        }
        reference = this.rehydrate(row);
        tx.validateReference(reference);
        if (tx.requiresReference()) {
          const duplicate = await em.query(
            "SELECT id FROM transactions WHERE reference_id=$1 AND kind=$2 AND status='PROCESSED'",
            [reference.props.id, tx.props.kind],
          );
          ensure(duplicate.length === 0, 'REFERENCE_ALREADY_REVERSED');
        }
      }
      if (tx.affectsBalance()) {
        const before = wallet.balance;
        const direction = tx.ledgerDirectionFor(reference);
        if (direction === 'DEBIT')
          wallet.debit(
            tx.props.money,
            tx.props.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS',
          );
        else wallet.credit(tx.props.money);
        entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: tx.props.id,
          direction,
          money: tx.props.money,
          balanceBefore: before,
          balanceAfter: wallet.balance,
          createdAt: new Date(),
        });
      }
      tx.markProcessed(reference?.props.id);
    } catch (error) {
      if (!(error instanceof AppError) || error.httpStatus >= 500) throw error;
      tx.reject(error.code);
    }
    if (entry && tx.status === 'PROCESSED') {
      await em
        .getRepository(WalletSchema)
        .update(wallet.id, { balance: wallet.balance.toString(), version: wallet.version });
      await em.query('UPDATE wallets SET updated_at=now() WHERE id=$1', [wallet.id]);
      await this.insertLedger(em, entry);
      await this.enqueue(
        em,
        WalletBalanceChanged.from(wallet.id, this.balanceEvent(wallet, entry), ctx),
      );
    }
    return this.saveResult(em, tx, wallet, ctx);
  }

  private balanceEvent(wallet: Wallet, entry: WalletLedgerEntry) {
    return {
      walletId: wallet.id,
      transactionId: entry.props.transactionId,
      direction: entry.props.direction,
      money: entry.props.money.toJSON(),
      balanceBefore: entry.props.balanceBefore.toJSON(),
      balanceAfter: entry.props.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    };
  }
  private async saveResult(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): Promise<Result> {
    const result: Result = {
      transactionId: tx.props.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: false,
    };
    await em.query(
      `UPDATE transactions SET status=$2,result=$3,failure_code=$4,reference_id=$5,
      processed_at=CASE WHEN $2='PROCESSED' THEN now() ELSE NULL END WHERE id=$1`,
      [tx.props.id, tx.status, result, tx.failureCode ?? null, tx.referenceTransactionId ?? null],
    );
    if (tx.status === 'PROCESSED')
      await this.enqueue(em, WagerTransactionProcessed.from(wallet.id, { ...result }, ctx));
    if (tx.status === 'REJECTED')
      await this.enqueue(em, WagerTransactionRejected.from(wallet.id, { ...result }, ctx));
    if (tx.status === 'FAILED')
      await this.enqueue(em, WagerTransactionFailed.from(wallet.id, { ...result }, ctx));
    return result;
  }
  async recordInfrastructureFailure(
    input: unknown,
    key: string,
    ctx: RequestContext,
    code: string,
  ): Promise<void> {
    const p = parseWager(input);
    const idempotencyKey = text(key, 'IDEMPOTENCY_KEY');
    const hash = payloadHash(p);
    await this.transaction(async (em) => {
      const wallet = await this.lockWallet(em, p.walletId);
      await em.query(
        `INSERT INTO transactions(id,wallet_id,provider_id,external_id,idempotency_key,payload_hash,kind,amount,currency,input,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING') ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          p.walletId,
          p.providerId,
          p.externalTransactionId,
          idempotencyKey,
          hash,
          p.kind,
          p.money.amount,
          p.money.currency,
          p,
        ],
      );
      const row = await em
        .getRepository(TransactionSchema)
        .findOneBy({ idempotency_key: idempotencyKey });
      ensure(row && row.payload_hash === hash, 'IDEMPOTENCY_CONFLICT', 409);
      const tx = this.rehydrate(row);
      // Um erro de ack posterior ao commit não pode transformar sucesso em falha.
      if (tx.isTerminal()) return;
      tx.fail(code);
      await this.saveResult(em, tx, wallet, ctx);
      if (ctx.messageId)
        await this.recordInbox(em, tx.props.id, ctx, payloadHash({ business: p, idempotencyKey }));
    });
    metrics.transactions.inc({ status: 'FAILED' });
  }
  private async insertLedger(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const p = entry.props;
    await em.query(
      `INSERT INTO ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        p.id,
        p.walletId,
        p.transactionId,
        p.direction,
        p.money.toString(),
        p.money.currency,
        p.balanceBefore.toString(),
        p.balanceAfter.toString(),
        p.createdAt,
      ],
    );
  }
  private async enqueue(em: EntityManager, event: IntegrationEvent<EventData>): Promise<void> {
    const outbox = OutboxMessage.enqueue(event);
    const p = outbox.payload;
    await em.query(
      'INSERT INTO outbox(id,aggregate_id,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,$5)',
      [p.eventId, p.aggregateId, p.eventType, p, p.occurredAt],
    );
  }
  private async recordInbox(
    em: EntityManager,
    transactionId: string,
    ctx: RequestContext,
    hash: string,
  ): Promise<void> {
    const inbox = InboxMessage.receive(ctx.messageId!, consumerName, ctx.inboxHash ?? hash);
    inbox.markProcessed(new Date());
    await em.query(
      `INSERT INTO inbox(consumer_name,message_id,payload_hash,transaction_id,processed_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [consumerName, inbox.messageId, inbox.payloadHash, transactionId, inbox.processedAt],
    );
    const [existing] = await em.query(
      'SELECT payload_hash,transaction_id FROM inbox WHERE consumer_name=$1 AND message_id=$2',
      [consumerName, inbox.messageId],
    );
    ensure(
      existing.payload_hash === inbox.payloadHash && existing.transaction_id === transactionId,
      'INBOX_CONFLICT',
      409,
    );
  }
  private async lockWallet(em: EntityManager, id: string): Promise<Wallet> {
    const row = await em
      .getRepository(WalletSchema)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.id = :id', { id })
      .getOne();
    ensure(row, 'WALLET_NOT_FOUND', 404);
    return this.walletFromRow(row);
  }
  private walletFromRow(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      balance: Money.rehydrate({ amount: row.balance, currency: row.currency }),
      version: row.version,
    });
  }
  private rehydrate(row: TransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      ...row.input,
      id: row.id,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
      status: row.status,
      failureCode: row.failure_code ?? undefined,
      referenceTransactionId: row.reference_id ?? undefined,
    });
  }

  async retryReferences(): Promise<void> {
    const due: { id: string; wallet_id: string }[] = await this.db.query(
      "SELECT id,wallet_id FROM transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 20",
    );
    for (const candidate of due) {
      const result = await this.transaction(async (em) => {
        const wallet = await this.lockWallet(em, candidate.wallet_id);
        const row = await em.getRepository(TransactionSchema).findOneByOrFail({ id: candidate.id });
        if (row.status !== 'PENDING_REFERENCE' || row.next_attempt_at.getTime() > Date.now())
          return;
        return this.apply(em, this.rehydrate(row), wallet, { correlationId: row.id }, row.attempts);
      });
      if (result) {
        metrics.retries.inc({ source: 'reference' });
        metrics.transactions.inc({ status: result.status });
      }
    }
  }
  async getWallet(id: string) {
    const row = await this.db.getRepository(WalletSchema).findOneBy({ id: uuid(id) });
    ensure(row, 'WALLET_NOT_FOUND', 404);
    return this.walletFromRow(row).toJSON();
  }
  async getTransaction(id: string) {
    const row = await this.db.getRepository(TransactionSchema).findOneBy({ id: uuid(id) });
    ensure(row, 'TRANSACTION_NOT_FOUND', 404);
    return row.result ?? { transactionId: row.id, status: row.status };
  }
  async getProviderTransaction(provider: string, external: string) {
    const row = await this.db
      .getRepository(TransactionSchema)
      .findOneBy({
        provider_id: text(provider, 'PROVIDER'),
        external_id: text(external, 'EXTERNAL_ID'),
      });
    ensure(row, 'TRANSACTION_NOT_FOUND', 404);
    return row.result ?? { transactionId: row.id, status: row.status };
  }
  async ledger(id: string, cursor?: string, rawLimit?: string) {
    await this.getWallet(id);
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_LIMIT', 400);
    let sequence = '0';
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        ensure(
          decoded.walletId === id &&
            typeof decoded.sequence === 'string' &&
            /^\d{1,19}$/.test(decoded.sequence),
          'INVALID_CURSOR',
          400,
        );
        ensure(BigInt(decoded.sequence) <= 9223372036854775807n, 'INVALID_CURSOR', 400);
        sequence = decoded.sequence;
      } catch {
        throw new AppError('INVALID_CURSOR', 400);
      }
    }
    const rows: {
      id: string;
      sequence: string;
      transaction_id: string;
      direction: string;
      amount: string;
      currency: string;
      balance_before: string;
      balance_after: string;
      created_at: Date;
    }[] = await this.db.query(
      'SELECT * FROM ledger WHERE wallet_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
      [id, sequence, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: { amount: r.amount, currency: r.currency },
        balanceBefore: { amount: r.balance_before, currency: r.currency },
        balanceAfter: { amount: r.balance_after, currency: r.currency },
        createdAt: r.created_at,
      })),
      nextCursor: hasMore
        ? Buffer.from(JSON.stringify({ walletId: id, sequence: page.at(-1)!.sequence })).toString(
            'base64url',
          )
        : null,
    };
  }
  async reconcile(id: string, ctx: EventContext) {
    return this.transaction(async (em) => {
      const wallet = await this.lockWallet(em, uuid(id));
      const [row] = await em.query(
        `SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::numeric(20,2)::text AS balance,
        count(*)::integer AS count FROM ledger WHERE wallet_id=$1`,
        [id],
      );
      const calculated = Money.rehydrate({
        amount: row.balance,
        currency: wallet.balance.currency,
      });
      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();
      if (!consistent) {
        metrics.reconciliation.inc();
        log('error', 'reconciliation_mismatch', { ...ctx, walletId: id });
      }
      return {
        walletId: id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: row.count,
      };
    });
  }
}
