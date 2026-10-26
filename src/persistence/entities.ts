import { EntitySchema } from 'typeorm';
import { WagerInput } from '../application/contracts';
import { MoneyProps } from '../domain/money';
import { Kind, Status } from '../domain/transaction';

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
}
export interface Result {
  transactionId: string;
  status: Status;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}
export interface TransactionRow {
  id: string;
  wallet_id: string;
  provider_id: string;
  external_id: string;
  idempotency_key: string;
  payload_hash: string;
  kind: Kind;
  amount: string;
  currency: string;
  input: WagerInput;
  status: Status;
  result: Result | null;
  reference_id: string | null;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
}
export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  columns: {
    id: { type: 'uuid', primary: true },
    player_id: { type: 'uuid' },
    currency: { type: 'varchar', length: 3 },
    balance: { type: 'numeric', precision: 20, scale: 2 },
    version: { type: 'integer' },
  },
});
export const TransactionSchema = new EntitySchema<TransactionRow>({
  name: 'TransactionRow',
  tableName: 'transactions',
  columns: {
    id: { type: 'uuid', primary: true },
    wallet_id: { type: 'uuid' },
    provider_id: { type: 'text' },
    external_id: { type: 'text' },
    idempotency_key: { type: 'text' },
    payload_hash: { type: 'text' },
    kind: { type: 'text' },
    amount: { type: 'numeric', precision: 20, scale: 2 },
    currency: { type: 'varchar', length: 3 },
    input: { type: 'jsonb' },
    status: { type: 'text' },
    result: { type: 'jsonb', nullable: true },
    reference_id: { type: 'uuid', nullable: true },
    failure_code: { type: 'text', nullable: true },
    attempts: { type: 'integer' },
    next_attempt_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz' },
  },
});
