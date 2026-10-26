import { createHash } from 'node:crypto';
import { ensure } from '../domain/errors';
import { Money, MoneyProps } from '../domain/money';
import { Kind } from '../domain/transaction';

export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<Kind, 'OPENING'>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export function object(input: unknown): Record<string, unknown> {
  ensure(
    input !== null && typeof input === 'object' && !Array.isArray(input),
    'INVALID_PAYLOAD',
    400,
  );
  return input as Record<string, unknown>;
}
export function text(input: unknown, name: string): string {
  ensure(
    typeof input === 'string' &&
      input.length > 0 &&
      input.length <= 200 &&
      input === input.trim() &&
      !/[\x00-\x1f]/.test(input),
    `INVALID_${name}`,
    400,
  );
  return input;
}
export function uuid(input: unknown): string {
  const value = text(input, 'UUID');
  ensure(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    'INVALID_UUID',
    400,
  );
  return value.toLowerCase();
}
export function moneyInput(input: unknown): Money {
  const value = object(input);
  return Money.from({ amount: value.amount as string, currency: value.currency as string });
}
export function parseWager(input: unknown): WagerInput {
  const p = object(input);
  ensure(
    ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(p.kind as string),
    'INVALID_KIND',
    400,
  );
  const result: WagerInput = {
    providerId: text(p.providerId, 'PROVIDER'),
    externalTransactionId: text(p.externalTransactionId, 'EXTERNAL_ID'),
    playerId: uuid(p.playerId),
    walletId: uuid(p.walletId),
    roundId: text(p.roundId, 'ROUND'),
    gameId: text(p.gameId, 'GAME'),
    kind: p.kind as WagerInput['kind'],
    money: moneyInput(p.money).toJSON(),
  };
  if (p.referenceExternalTransactionId !== undefined)
    result.referenceExternalTransactionId = text(p.referenceExternalTransactionId, 'REFERENCE');
  ensure(
    !['REFUND', 'ROLLBACK'].includes(result.kind) || result.referenceExternalTransactionId,
    'REFERENCE_REQUIRED',
    400,
  );
  ensure(
    !['BET', 'LOSS'].includes(result.kind) || !result.referenceExternalTransactionId,
    'UNEXPECTED_REFERENCE',
    400,
  );
  ensure(
    result.referenceExternalTransactionId !== result.externalTransactionId,
    'SELF_REFERENCE',
    400,
  );
  const money = Money.from(result.money);
  ensure(
    result.kind === 'LOSS' ? money.isZero() : money.isPositive(),
    'INVALID_OPERATION_AMOUNT',
    400,
  );
  return result;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
