/**
 * Deliveries made by other workers (#5516; test contract T1, T13 and T23's
 * exit case, in the first-version form: relay intake is #5526). A second
 * worker is a fresh module graph over the same database, so nothing in
 * memory is shared with the sender. Every such delivery is refused visibly
 * as `relay_unsupported`; the charge, the usage rows and the handlers are
 * untouched, however many copies arrive at once.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import {
  ledgerFixture,
  readOnlyCall,
  resetStub,
  runTotals,
  stub,
  stubGetAI,
  usageRows,
} from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
} from './fixtures/ai-run-test-db';

const counted = (total: number) => ({
  promptTokens: Math.floor(total / 2),
  completionTokens: total - Math.floor(total / 2),
  totalTokens: total,
});

beforeEach(() => {
  config.reset();
  resetStub();
  getAIMock.mockReset();
  getAIMock.mockImplementation(stubGetAI);
});
afterEach(async () => {
  config.reset();
  vi.resetModules();
  await closeAiRunTestDatabases();
});

async function worker(db: unknown, handled: SmrtAiUsageEvent[]) {
  vi.resetModules();
  const fresh = await import('../adapters/ai-usage-recorder');
  return fresh.createAiUsageRecorder({
    db: db as never,
    tenantId: 'tenant-a',
    usage: { handlers: [{ handle: async (e) => void handled.push(e) }] },
  });
}

describe.each(
  aiRunTestEngines,
)('deliveries from other workers on %s', (engine) => {
  it('two workers delivering one event at once both refuse it; a third copy changes nothing', async () => {
    const records: SmrtAiUsageEvent[] = [];
    const f = await ledgerFixture(engine, {
      usage: {
        handlers: [
          { handle: async (e: SmrtAiUsageEvent) => void records.push(e) },
        ],
      },
    });
    let late: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      late = call.build({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    expect(records).toHaveLength(1);
    const before = await runTotals(f.db, f.run.id);
    const handled: SmrtAiUsageEvent[] = [];
    const a = await worker(f.db, handled);
    const b = await worker(f.db, handled);
    await Promise.all([a(late), b(structuredClone(late))]);
    await a(JSON.parse(JSON.stringify(late)));
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    expect(await usageRows(f.db)).toHaveLength(1);
    expect(handled).toHaveLength(0);
    expect(records).toHaveLength(1);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(
      (call.callUsage?.refused as Record<string, number>)?.relay_unsupported,
    ).toBe(3);
  });

  it('a delivery while the call is still reserved is refused and nothing is parked', async () => {
    const f = await ledgerFixture(engine);
    let reserved: Record<string, unknown> | undefined;
    const handled: SmrtAiUsageEvent[] = [];
    stub.script.onCall = async (call) => {
      reserved = call.build({ index: 0, usage: counted(9) });
      const other = await worker(f.db, handled);
      await other(reserved);
      const during = await readOnlyCall(f.db, f.run.id);
      expect(during.callState).toBe('reserved');
      expect(during.callUsage?.counted).toBeUndefined();
      await call.emit({ index: 0, last: true, usage: counted(9) });
      return 'answer';
    };
    await f.client.message('hello');
    expect((await readOnlyCall(f.db, f.run.id)).chargedTokens).toBe(9);
    expect(handled).toHaveLength(0);
  });

  it('after the sender committed, a repeat from a restarted worker sends no record and keeps the ledger', async () => {
    const records: SmrtAiUsageEvent[] = [];
    const f = await ledgerFixture(engine, {
      usage: {
        handlers: [
          { handle: async (e: SmrtAiUsageEvent) => void records.push(e) },
        ],
      },
    });
    let copy: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, last: true, usage: counted(7) });
      copy = call.build({ index: 0, last: true, usage: counted(7) });
      return 'answer';
    };
    await f.client.message('hello');
    const handled: SmrtAiUsageEvent[] = [];
    const restarted = await worker(f.db, handled);
    await restarted(copy);
    expect(records).toHaveLength(1);
    expect(handled).toHaveLength(0);
    expect((await readOnlyCall(f.db, f.run.id)).chargedTokens).toBe(7);
  });
});
