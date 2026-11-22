/**
 * PostgreSQL lane of the AI call ledger (#5516; test contract T14, T19, T20
 * and T23 on PostgreSQL). The cutover runs in a database of its own, created
 * and dropped here, because it rewrites the system tables other files use.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * server.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import { ensureSystemTables } from '../system/bootstrap';
import {
  checkAiRunTotals,
  flushAiRunSettlements,
  openAiRun,
  sweepAiRuns,
} from '../system/browser';
import {
  closingWrite,
  flushHeld,
  ledgerFixture,
  MINUTE,
  readOnlyCall,
  resetStub,
  runTotals,
  stub,
  stubGetAI,
  usageRows,
} from './fixtures/ai-call-ledger-harness';
import {
  downgradeToV120,
  insertV120Reservation,
} from './fixtures/ai-call-ledger-v1-20';
import { beforeStatement, rowsOf } from './fixtures/ai-run-test-db';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const counted = (total: number) => ({
  promptTokens: Math.floor(total / 2),
  completionTokens: total - Math.floor(total / 2),
  totalTokens: total,
});

async function connect(url: string, dbid: string): Promise<DatabaseInterface> {
  return (await getDatabase({ type: 'postgres', url, dbid } as Parameters<
    typeof getDatabase
  >[0])) as DatabaseInterface;
}

describe.skipIf(!pgUrl)('AI call ledger on PostgreSQL (#5516)', () => {
  let admin: DatabaseInterface;
  let db: DatabaseInterface;
  let other: DatabaseInterface;
  const name = `smrt_ledger_${Date.now().toString(36)}`;

  beforeAll(async () => {
    admin = await connect(pgUrl as string, 'smrt-test-5516-admin');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(pgUrl as string);
    url.pathname = `/${name}`;
    db = await connect(url.toString(), 'smrt-test-5516-a');
    other = await connect(url.toString(), 'smrt-test-5516-b');
    await ensureSystemTables(db, 'postgres');
  });

  afterAll(async () => {
    await db?.close?.();
    await other?.close?.();
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.close?.();
  });

  beforeEach(() => {
    config.reset();
    resetStub();
    getAIMock.mockReset();
    getAIMock.mockImplementation(stubGetAI);
  });

  it('bills a late part the sum of distinct parts, priced from the reservation', async () => {
    const f = await ledgerFixture('pglite', { db });
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    expect(await readOnlyCall(db, f.run.id)).toMatchObject({
      usageSource: 'complete',
      chargedTokens: 15,
    });
    expect((await runTotals(db, f.run.id)).tokens).toBe(15);
    expect((await checkAiRunTotals(db, f.run.id)).matches).toBe(true);
  });

  it('the sweep charges parked parts and the live sender merges its difference', async () => {
    const f = await ledgerFixture('pglite', { db });
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, usage: counted(6) });
      return {
        content: 'answer',
        usageParts: {
          call: call.sdkCall,
          complete: true,
          parts: [
            { index: 0, usage: counted(6) },
            { index: 1, last: true, usage: counted(14) },
          ],
        },
      };
    };
    const restore = beforeStatement(db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.chat([{ role: 'user', content: 'x' }]);
    restore();
    await flushHeld();
    await sweepAiRuns(db, {
      now: () => new Date(Date.now() + 2 * 60 * MINUTE),
    });
    expect((await readOnlyCall(db, f.run.id)).chargedTokens).toBe(6);
    await flushAiRunSettlements(db);
    expect((await readOnlyCall(db, f.run.id)).chargedTokens).toBe(20);
    expect(
      (await usageRows(db)).filter((r) => r.run_id === f.run.id),
    ).toHaveLength(1);
  });

  it('a reservation inserted while the cutover waits for the table lock is counted and blocks it', async () => {
    const cutoverDb = `${name}_cut`;
    await admin.query(`CREATE DATABASE ${cutoverDb}`);
    const url = new URL(pgUrl as string);
    url.pathname = `/${cutoverDb}`;
    const a = await connect(url.toString(), 'smrt-test-5516-cut-a');
    const b = await connect(url.toString(), 'smrt-test-5516-cut-b');
    try {
      await ensureSystemTables(a, 'postgres');
      await downgradeToV120(a, 'postgres');
      const run = await openAiRun(
        { db: a, usageTracking: true, tenantId: null },
        {
          type: 'turn',
          budget: { callTimeoutMs: 2 * 60 * MINUTE },
        },
      );
      const tx = await b.beginTransaction?.();
      if (!tx) throw new Error('no transaction');
      await insertV120Reservation(tx as unknown as DatabaseInterface, {
        runId: run.id,
        callId: 'racing',
        createdAt: new Date(),
      });
      const cutover = ensureSystemTables(a, 'postgres').catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.commit();
      expect(await cutover).toMatchObject({
        code: 'AI_RUN_CUTOVER_BLOCKED',
        details: expect.objectContaining({ count: 1 }),
      });
      const columns = rowsOf(
        await a.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = '_smrt_ai_run_events'`,
        ),
      ).map((row) => String(row.column_name));
      expect(columns).toContain('reservation');
    } finally {
      await a.close?.();
      await b.close?.();
      await admin.query(`DROP DATABASE IF EXISTS ${cutoverDb} WITH (FORCE)`);
    }
  });
});
