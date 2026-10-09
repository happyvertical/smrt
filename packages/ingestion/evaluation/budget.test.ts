import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  BudgetLedger,
  runReservedCall,
  TOTAL_CAP,
  tokenChargeBound,
} from './budget.mjs';

const roots: string[] = [];
const request = (id: string, maximumCharge = 100) => ({
  id,
  maximumCharge,
  requestHash: 'a'.repeat(64),
  runHash: 'b'.repeat(64),
  stage: 'proposal',
});
function path() {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-budget-'));
  roots.push(root);
  return join(root, 'ledger.sqlite');
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('persistent aggregate ceiling spans stages/restarts; retries cannot reissue an uncertain call', async () => {
  const file = path();
  let ledger = new BudgetLedger(file);
  let calls = 0;
  await runReservedCall(ledger, request('ocr', TOTAL_CAP - 1), async () => {
    calls++;
    return {};
  });
  ledger.close();
  ledger = new BudgetLedger(file);
  await expect(
    runReservedCall(ledger, request('speech', 2), async () => {
      calls++;
    }),
  ).rejects.toThrow('exhausted');
  await expect(
    runReservedCall(ledger, request('ocr', 1), async () => {
      calls++;
    }),
  ).rejects.toThrow('already reserved');
  await runReservedCall(ledger, request('last', 1), async () => {
    calls++;
    return {};
  });
  expect(calls).toBe(2);
  expect(ledger.snapshot().remaining).toBe(0);
  ledger.close();
});
test('verified final usage refunds only once; cancellation and crashes retain full reserves', async () => {
  const file = path();
  let ledger = new BudgetLedger(file);
  await runReservedCall(ledger, request('known'), async () => ({
    charge: { kind: 'verified-final', nanoUSD: 25 },
  }));
  expect(() => ledger.settle('known', 0)).toThrow('not unsettled');
  await expect(
    runReservedCall(ledger, request('cancel'), async () => {
      throw new Error('remote may continue');
    }),
  ).rejects.toThrow('remote may continue');
  ledger.reserve(request('crash'));
  ledger.close();
  ledger = new BudgetLedger(file);
  expect(ledger.snapshot().charged).toBe(225);
  expect(() => ledger.reserve(request('crash'))).toThrow('already reserved');
  ledger.close();
});
test('actual bound breach halts future calls and never reduces retained charges', async () => {
  const ledger = new BudgetLedger(path());
  await expect(
    runReservedCall(ledger, request('breach'), async () => ({
      charge: { kind: 'verified-final', nanoUSD: 101 },
    })),
  ).rejects.toThrow('halted');
  expect(() => ledger.reserve(request('next'))).toThrow('halted');
  expect(ledger.snapshot().charged).toBe(100);
  ledger.close();
});
test('invalid, zero, fractional and overflowing cost bounds fail closed', () => {
  expect(() => new BudgetLedger(':memory:')).toThrow('Persistent');
  const ledger = new BudgetLedger(path());
  for (const amount of [0, -1, NaN, 1.2, Number.MAX_SAFE_INTEGER + 1])
    expect(() => ledger.reserve(request('invalid', amount))).toThrow();
  expect(ledger.snapshot().charged).toBe(0);
  expect(
    tokenChargeBound({
      inputTokens: 1000,
      outputTokens: 100,
      inputNanoUSD: 125,
      outputNanoUSD: 500,
    }),
  ).toBe(175_000);
  expect(() =>
    tokenChargeBound({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      inputNanoUSD: 125,
      outputNanoUSD: 500,
    }),
  ).toThrow();
  ledger.close();
});
test('independent concurrent processes cannot oversubscribe the one ledger', async () => {
  const file = path();
  const ledger = new BudgetLedger(file);
  ledger.close();
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<string>((resolve, reject) => {
          const child = fork(
            new URL('./reserve-child.mjs', import.meta.url),
            [file, String(index)],
            { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
          );
          let message: string | undefined;
          child.on('message', (value) => {
            message = String(value);
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 && message
              ? resolve(message)
              : reject(new Error(`Reservation child exited ${code}`)),
          );
        }),
    ),
  );
  expect(results.filter((value) => value === 'invoked')).toHaveLength(5);
  const reopened = new BudgetLedger(file);
  expect(reopened.snapshot().charged).toBe(TOTAL_CAP);
  reopened.close();
});
test('known overrun survives restart with truthful actual/exposure and no spendable remainder', () => {
  const file = path();
  let ledger = new BudgetLedger(file);
  ledger.reserve(request('overrun', 1));
  expect(ledger.settle('overrun', 7)).toBe(false);
  ledger.close();
  ledger = new BudgetLedger(file);
  expect(ledger.snapshot()).toMatchObject({
    halted: true,
    charged: 1,
    remaining: 0,
    observedActualNanoUSD: '7',
    accountedExposureNanoUSD: '7',
  });
  expect(ledger.snapshot().calls[0]).toMatchObject({
    state: 'overrun',
    failure: 'charge_bound_exceeded',
  });
  expect(ledger.snapshot().calls[0].observed_charge).toBe(7);
  ledger.close();
});
test('malformed verified charges never release reservations', async () => {
  const ledger = new BudgetLedger(path());
  for (const [index, nanoUSD] of [
    NaN,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
  ].entries())
    await expect(
      runReservedCall(ledger, request(`malformed-${index}`), async () => ({
        charge: { kind: 'verified-final', nanoUSD },
      })),
    ).rejects.toThrow();
  expect(ledger.snapshot().charged).toBe(500);
  expect(ledger.snapshot().unknownChargeCalls).toBe(5);
  ledger.close();
});
test('same call identity across processes reserves once', async () => {
  const file = path();
  const initial = new BudgetLedger(file);
  initial.close();
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      (_, index) =>
        new Promise<string>((resolve, reject) => {
          const child = fork(
            new URL('./reserve-child.mjs', import.meta.url),
            [file, String(index), 'same-call'],
            { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
          );
          let message: string | undefined;
          child.on('message', (value) => {
            message = String(value);
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 && message
              ? resolve(message)
              : reject(new Error(`Reservation child exited ${code}`)),
          );
        }),
    ),
  );
  expect(results.filter((value) => value === 'invoked')).toHaveLength(1);
  const ledger = new BudgetLedger(file);
  expect(ledger.snapshot().charged).toBe(1_000_000_000);
  ledger.close();
});
