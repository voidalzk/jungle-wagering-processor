import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/persistence/database';
import { WageringService } from '../../src/application/wagering';
import { WagerInput } from '../../src/application/contracts';

export const db = createDatabase();
export const service = new WageringService(db);
export const ctx = () => ({ correlationId: randomUUID() });
export async function initialize() {
  if (!db.isInitialized) {
    await db.initialize();
    await db.runMigrations();
  }
}
export async function open(amount = '100.00') {
  return service.openWallet(
    { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } },
    ctx(),
  );
}
export function wager(
  wallet: { id: string; playerId: string },
  overrides: Partial<WagerInput> = {},
): WagerInput {
  return {
    walletId: wallet.id,
    playerId: wallet.playerId,
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}
export async function submit(p: WagerInput, key = `${p.providerId}:${p.externalTransactionId}`) {
  return service.submit(p, key, ctx());
}
export async function consistent(id: string) {
  const result = await service.reconcile(id, ctx());
  if (!result.consistent) throw new Error('Ledger divergence');
  return result;
}
export async function eventually<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (accepted(result)) return result;
    await Bun.sleep(100);
  }
  throw new Error('Timed out waiting for condition');
}
