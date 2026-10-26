import { ensure } from './errors';
import { Money } from './money';
import { Direction } from './transaction';

export interface LedgerProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: Direction;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}
export class WalletLedgerEntry {
  private constructor(readonly props: Readonly<LedgerProps>) {
    Object.freeze(props);
    Object.freeze(this);
  }
  static create(props: LedgerProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({ ...props });
    ensure(
      props.money.isPositive() && !props.balanceAfter.isNegative() && entry.isBalanced(),
      'UNBALANCED_LEDGER',
      500,
    );
    return entry;
  }
  static rehydrate(props: LedgerProps): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...props });
  }
  isBalanced(): boolean {
    const p = this.props;
    const delta = p.direction === 'CREDIT' ? p.money : p.money.negate();
    return p.balanceBefore.add(delta).equals(p.balanceAfter);
  }
}
