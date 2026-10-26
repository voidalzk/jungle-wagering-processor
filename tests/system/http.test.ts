import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db, initialize, wager, consistent, eventually } from '../support/database';

const ports = [33101, 33102, 33103];
const children: ReturnType<typeof Bun.spawn>[] = [];
function start(port: number) {
  return Bun.spawn([process.execPath, 'dist/main.js'], {
    env: { ...process.env, PORT: String(port), WORKERS_ENABLED: 'false', LOG_LEVEL: 'silent' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
}
async function waitReady(port: number) {
  await eventually(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    30000,
  );
}
async function request(path: string, body?: unknown, instance = 0, key?: string) {
  const response = await fetch(`http://127.0.0.1:${ports[instance]}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
beforeAll(async () => {
  await initialize();
  for (const port of ports) children.push(start(port));
  await Promise.all(ports.map(waitReady));
});
afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  if (db.isInitialized) await db.destroy();
});

test('três processos recebem a mesma operação 50 vezes', async () => {
  const created = await request('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  const input = wager({ id: created.body.id, playerId: created.body.playerId });
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => request('/wagering/transactions', input, i % 3, key)),
  );
  expect(results.every((r) => r.status === 200)).toBe(true);
  expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
  expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
  expect((await consistent(created.body.id)).storedBalance.amount).toBe('90.00');
});
test('disputa por saldo atravessa instâncias e não deixa saldo negativo', async () => {
  const created = await request('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const wallet = { id: created.body.id, playerId: created.body.playerId };
  const results = await Promise.all(
    [0, 1].map((i) =>
      request(
        '/wagering/transactions',
        wager(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
        i,
        randomUUID(),
      ),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
  expect((await consistent(wallet.id)).storedBalance.amount).toBe('20.00');
});
test('HTTP distingue inválido, conflito, rejeição e aceite pendente', async () => {
  const created = await request('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const wallet = { id: created.body.id, playerId: created.body.playerId };
  const input = wager(wallet);
  const key = randomUUID();
  expect((await request('/wagering/transactions', input)).status).toBe(400);
  expect(
    (await request('/wagering/transactions', { ...input, kind: 'OPENING' }, 0, key)).status,
  ).toBe(400);
  expect((await request('/wagering/transactions', input, 0, key)).status).toBe(200);
  expect(
    (await request('/wagering/transactions', { ...input, roundId: 'other' }, 0, key)).status,
  ).toBe(409);
  expect(
    (
      await request(
        '/wagering/transactions',
        wager(wallet, { money: { amount: '1000.00', currency: 'BRL' } }),
        0,
        randomUUID(),
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await request(
        '/wagering/transactions',
        wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() }),
        0,
        randomUUID(),
      )
    ).status,
  ).toBe(202);
  await consistent(wallet.id);
});
test('reiniciar aplicação mantém replay, consultas e reconciliação', async () => {
  const created = await request('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const wallet = { id: created.body.id, playerId: created.body.playerId };
  const input = wager(wallet);
  const key = randomUUID();
  const original = await request('/wagering/transactions', input, 0, key);
  children[0]!.kill();
  await children[0]!.exited;
  children[0] = start(ports[0]!);
  await waitReady(ports[0]!);
  const replay = await request('/wagering/transactions', input, 0, key);
  expect(replay.body.transactionId).toBe(original.body.transactionId);
  expect(replay.body.idempotentReplay).toBe(true);
  expect((await request(`/wagering/transactions/${original.body.transactionId}`)).status).toBe(200);
  expect(
    (
      await request(
        `/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`,
      )
    ).status,
  ).toBe(200);
  expect((await request(`/wallets/${wallet.id}/reconciliation`, {})).body.consistent).toBe(true);
  expect((await request(`/wallets/${wallet.id}/ledger?limit=1`)).body.nextCursor).toBeTruthy();
});
