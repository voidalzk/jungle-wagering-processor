import { ensure } from './errors';
import { Money } from './money';

export type Kind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type Direction = 'DEBIT' | 'CREDIT';
export interface TransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
}
export interface TransactionState extends TransactionProps {
  status: Status;
  failureCode?: string;
  referenceTransactionId?: string;
}

export class WagerTransaction {
  private constructor(
    readonly props: Readonly<TransactionProps>,
    private _status: Status,
    private _failureCode?: string,
    private _referenceTransactionId?: string,
  ) {
    Object.freeze(props);
  }
  static create(props: TransactionProps): WagerTransaction {
    ensure(
      !['REFUND', 'ROLLBACK'].includes(props.kind) || props.referenceExternalTransactionId,
      'REFERENCE_REQUIRED',
      400,
    );
    ensure(
      props.kind === 'LOSS' ? props.money.isZero() : props.money.isPositive(),
      'INVALID_OPERATION_AMOUNT',
      400,
    );
    return new WagerTransaction({ ...props }, 'PENDING');
  }
  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction(
      { ...state },
      state.status,
      state.failureCode,
      state.referenceTransactionId,
    );
  }
  get status(): Status {
    return this._status;
  }
  get failureCode(): string | undefined {
    return this._failureCode;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  isTerminal(): boolean {
    return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status);
  }
  matchesPayload(hash: string): boolean {
    return this.props.payloadHash === hash;
  }
  affectsBalance(): boolean {
    return this.props.kind !== 'LOSS';
  }
  requiresReference(): boolean {
    return ['REFUND', 'ROLLBACK'].includes(this.props.kind);
  }
  markPendingReference(): void {
    this.transition('PENDING_REFERENCE');
  }
  markProcessed(referenceId?: string): void {
    this.transition('PROCESSED');
    this._referenceTransactionId = referenceId;
  }
  reject(code: string): void {
    this.transition('REJECTED');
    this._failureCode = code;
  }
  fail(code: string): void {
    this.transition('FAILED');
    this._failureCode = code;
  }
  private transition(status: Status): void {
    ensure(!this.isTerminal(), 'INVALID_TRANSACTION_STATE', 500);
    this._status = status;
  }

  validateReference(reference: WagerTransaction): void {
    const p = this.props;
    const r = reference.props;
    ensure(reference.status === 'PROCESSED', 'REFERENCE_NOT_PROCESSED');
    ensure(
      p.providerId === r.providerId &&
        p.playerId === r.playerId &&
        p.walletId === r.walletId &&
        p.roundId === r.roundId,
      'REFERENCE_CONTEXT_MISMATCH',
    );
    ensure(p.money.currency === r.money.currency, 'CURRENCY_MISMATCH');
    ensure(p.id !== r.id, 'SELF_REFERENCE');
    const allowed = p.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
    ensure(allowed.includes(r.kind), 'INVALID_REFERENCE_KIND');
    if (this.requiresReference()) ensure(p.money.equals(r.money), 'REFERENCE_AMOUNT_MISMATCH');
  }
  ledgerDirectionFor(reference?: WagerTransaction): Direction {
    ensure(this.affectsBalance(), 'NO_LEDGER_FOR_LOSS', 500);
    if (this.props.kind === 'BET') return 'DEBIT';
    if (this.props.kind === 'ROLLBACK') {
      ensure(reference, 'REFERENCE_REQUIRED');
      return reference.props.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }
    return 'CREDIT';
  }
}
