import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, Kind, TransactionProps } from '../../src/domain/transaction';
import { WalletLedgerEntry } from '../../src/domain/ledger';
import { InboxMessage, OutboxMessage } from '../../src/domain/messages';
import { WagerTransactionProcessed } from '../../src/domain/events';
import { canonical, parseWager, payloadHash } from '../../src/application/contracts';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const props = (kind: Kind = 'BET'): TransactionProps => ({
  id: randomUUID(),
  providerId: 'provider-a',
  externalTransactionId: 'bet-1',
  idempotencyKey: 'key',
  payloadHash: 'hash',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind,
  money: money('10.00'),
});

describe('Money', () => {
  test('opera com precisão, inclusive acima do limite seguro de number', () => {
    expect(money('0.10').add(money('0.20')).toString()).toBe('0.30');
    expect(money('9007199254740993.00').add(money('0.01')).toString()).toBe('9007199254740993.01');
    expect(money('1').toString()).toBe('1.00');
    expect(money('1.2').toString()).toBe('1.20');
    expect(money('10').subtract(money('11')).toString()).toBe('-1.00');
    expect(money('10').negate().negate().equals(money('10'))).toBe(true);
  });
  test.each([
    'NaN',
    'Infinity',
    '1e2',
    '',
    '-1',
    '0.001',
    ' 1.00',
    '+1',
    '1,00',
    '01.00',
    '1000000000000000000',
  ])('rejeita %s sem arredondar silenciosamente', (amount) => {
    expect(() => money(amount)).toThrow();
  });
  test('rejeita number recebido em JSON e moeda inválida', () => {
    expect(() => money(10 as unknown as string)).toThrow();
    expect(() => money('1', 'brl')).toThrow();
    expect(() => money('1', 'ABC')).toThrow();
  });
  test('não altera a instância original e detecta conflito de moeda', () => {
    const original = money('10');
    original.add(money('5'));
    expect(original.toString()).toBe('10.00');
    expect(() => original.add(money('1', 'USD'))).toThrow('CURRENCY_MISMATCH');
    expect(() => original.equals(money('10', 'USD'))).toThrow('CURRENCY_MISMATCH');
    expect(() => money('999999999999999999.99').add(money('0.01'))).toThrow('AMOUNT_OUT_OF_RANGE');
  });
});
describe('Wallet', () => {
  test('preserva saldo e versão ao rejeitar um débito', () => {
    const wallet = Wallet.open('w', 'p', money('100'));
    wallet.debit(money('80'));
    expect(wallet.version).toBe(2);
    expect(() => wallet.debit(money('80'))).toThrow('INSUFFICIENT_FUNDS');
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    wallet.credit(money('0'));
    expect(wallet.version).toBe(2);
    wallet.credit(money('5'));
    expect(wallet.version).toBe(3);
    expect(() => wallet.credit(money('1', 'USD'))).toThrow('CURRENCY_MISMATCH');
  });
  test('não permite abertura negativa', () => {
    expect(() => Wallet.open('w', 'p', money('1').negate())).toThrow();
  });
});
describe('WagerTransaction', () => {
  test('BET debita, WIN credita e LOSS não movimenta', () => {
    expect(WagerTransaction.create(props()).ledgerDirectionFor()).toBe('DEBIT');
    expect(WagerTransaction.create(props('WIN')).ledgerDirectionFor()).toBe('CREDIT');
    const loss = WagerTransaction.create({ ...props('LOSS'), money: money('0') });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow();
  });
  test('REFUND e ROLLBACK validam referências e direção', () => {
    const bet = WagerTransaction.create(props());
    bet.markProcessed();
    const refund = WagerTransaction.create({
      ...props('REFUND'),
      referenceExternalTransactionId: 'bet-1',
    });
    refund.validateReference(bet);
    expect(refund.ledgerDirectionFor(bet)).toBe('CREDIT');
    const rollback = WagerTransaction.create({
      ...props('ROLLBACK'),
      referenceExternalTransactionId: 'bet-1',
    });
    rollback.validateReference(bet);
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    const win = WagerTransaction.create(props('WIN'));
    win.markProcessed();
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    expect(() => refund.validateReference(win)).toThrow('INVALID_REFERENCE_KIND');
    const wrongAmount = WagerTransaction.create({
      ...props('REFUND'),
      money: money('11'),
      referenceExternalTransactionId: 'bet-1',
    });
    expect(() => wrongAmount.validateReference(bet)).toThrow('REFERENCE_AMOUNT_MISMATCH');
    const wrongWallet = WagerTransaction.create({
      ...props('REFUND'),
      walletId: 'other',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(() => wrongWallet.validateReference(bet)).toThrow('REFERENCE_CONTEXT_MISMATCH');
  });
  test('estados terminais não mudam e payload divergente é detectado', () => {
    const tx = WagerTransaction.create(props());
    tx.markPendingReference();
    tx.reject('REFERENCE_EXPIRED');
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed()).toThrow('INVALID_TRANSACTION_STATE');
    expect(tx.matchesPayload('other')).toBe(false);
    const failed = WagerTransaction.create(props());
    failed.fail('STORAGE_ERROR');
    expect(failed.status).toBe('FAILED');
    expect(() => failed.reject('ERROR')).toThrow();
  });
});
test('ledger é imutável e valida a aritmética', () => {
  const entry = {
    id: 'l',
    walletId: 'w',
    transactionId: 't',
    direction: 'DEBIT' as const,
    money: money('10'),
    balanceBefore: money('20'),
    balanceAfter: money('10'),
    createdAt: new Date(),
  };
  expect(WalletLedgerEntry.create(entry).isBalanced()).toBe(true);
  expect(Object.isFrozen(WalletLedgerEntry.create(entry).props)).toBe(true);
  expect(() => WalletLedgerEntry.create({ ...entry, balanceAfter: money('11') })).toThrow(
    'UNBALANCED_LEDGER',
  );
});
test('canonicalização ordena chaves e ignora metadados fora do contrato', () => {
  expect(canonical({ b: 2, a: { z: 1, c: 0 } })).toBe('{"a":{"c":0,"z":1},"b":2}');
  expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  const input = {
    ...props(),
    walletId: randomUUID(),
    playerId: randomUUID(),
    money: money('10').toJSON(),
  };
  expect(parseWager({ ...input, transport: 'ignored' })).not.toHaveProperty('transport');
  expect(() => parseWager({ ...input, kind: 'OPENING' })).toThrow('INVALID_KIND');
});
test('inbox e outbox têm transições explícitas', () => {
  const inbox = InboxMessage.receive('m', 'consumer', 'hash');
  inbox.markProcessed(new Date());
  expect(inbox.isProcessed()).toBe(true);
  expect(() => inbox.markProcessed(new Date())).toThrow();
  const outbox = OutboxMessage.enqueue(
    WagerTransactionProcessed.from('w', { status: 'PROCESSED' }, { correlationId: 'c' }),
  );
  const now = new Date();
  outbox.scheduleRetry(now, 1000);
  expect(outbox.nextAttemptAt!.getTime() - now.getTime()).toBe(1000);
  outbox.scheduleRetry(now, 1000);
  expect(outbox.nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
  expect(outbox.isDue(now)).toBe(false);
  outbox.markPublished(now);
  expect(outbox.isPending()).toBe(false);
});
