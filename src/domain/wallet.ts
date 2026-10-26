import { ensure } from './errors';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    private _balance: Money,
    private _version: number,
  ) {}
  static open(id: string, playerId: string, balance: Money): Wallet {
    ensure(!balance.isNegative(), 'NEGATIVE_BALANCE');
    return new Wallet(id, playerId, balance, 1);
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.balance, state.version);
  }
  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  debit(money: Money, failureCode = 'INSUFFICIENT_FUNDS'): void {
    ensure(!money.isNegative(), 'INVALID_AMOUNT');
    ensure(!this._balance.isLessThan(money), failureCode);
    this.move(money.negate());
  }
  credit(money: Money): void {
    ensure(!money.isNegative(), 'INVALID_AMOUNT');
    this.move(money);
  }
  private move(money: Money): void {
    this._balance = this._balance.add(money);
    if (!money.isZero()) this._version++;
  }
  toJSON() {
    return {
      id: this.id,
      playerId: this.playerId,
      balance: this.balance.toJSON(),
      version: this.version,
    };
  }
}
