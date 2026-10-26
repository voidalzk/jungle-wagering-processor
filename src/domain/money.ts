import { ensure } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}
const currencies: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    ensure(
      cents >= -99999999999999999999n && cents <= 99999999999999999999n,
      'AMOUNT_OUT_OF_RANGE',
    );
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    ensure(props && typeof props.amount === 'string', 'INVALID_AMOUNT', 400);
    ensure(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/.test(props.amount), 'INVALID_AMOUNT', 400);
    ensure(
      typeof props.currency === 'string' && currencies.has(props.currency),
      'INVALID_CURRENCY',
      400,
    );
    const [whole = '0', fraction = ''] = props.amount.split('.');
    return new Money(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')), props.currency);
  }

  static rehydrate(props: MoneyProps): Money {
    const negative = props.amount.startsWith('-');
    const value = Money.from({ ...props, amount: negative ? props.amount.slice(1) : props.amount });
    return negative ? value.negate() : value;
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }
  subtract(other: Money): Money {
    return this.add(other.negate());
  }
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }
  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }
  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
  private assertSameCurrency(other: Money): void {
    ensure(this.currency === other.currency, 'CURRENCY_MISMATCH');
  }
}
