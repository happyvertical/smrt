/**
 * A tracked call's secret is stored nowhere (#5516, plan section 3.1; test
 * contract T17). The reservation keeps its SHA-256 digest; the secret lives
 * in the call's handle and its usage tags only, and core removes it from
 * every tag map it stores or hands to a handler. Readers never return the
 * ledger's private columns.
 */

import { createHash } from 'node:crypto';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import { getRunTrajectory } from '../system/browser';
import {
  flushHeld,
  ledgerFixture,
  readOnlyCall,
  resetStub,
  stub,
  stubGetAI,
} from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  rowsOf,
} from './fixtures/ai-run-test-db';

beforeEach(() => {
  config.reset();
  resetStub();
  getAIMock.mockReset();
  getAIMock.mockImplementation(stubGetAI);
});
afterEach(async () => {
  config.reset();
  vi.restoreAllMocks();
  await closeAiRunTestDatabases();
});

const AI_TABLES = [
  '_smrt_ai_usage',
  '_smrt_ai_runs',
  '_smrt_ai_run_events',
  '_smrt_ai_run_checkpoints',
  '_smrt_ai_evaluations',
  '_smrt_ai_transcripts',
  '_smrt_ai_run_ids',
];

describe.each(aiRunTestEngines)('call proof storage on %s', (engine) => {
  it('no table, handler argument or log line holds the secret; the reservation holds its digest', async () => {
    config({
      inference: { transcripts: { enabled: true, sample: 1 } },
    } as never);
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    const records: SmrtAiUsageEvent[] = [];
    const f = await ledgerFixture(engine, {
      usage: {
        handlers: [
          { handle: async (e: SmrtAiUsageEvent) => void records.push(e) },
        ],
      },
    });
    stub.script.onCall = async (call) => {
      await call.emit({
        index: 0,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      call.hold({
        index: 1,
        last: true,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    const secret = (stub.sent[0]?.usageTags as Record<string, string>)
      ?.aiCallProof;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.callProof).toBe(
      createHash('sha256')
        .update(secret as string)
        .digest('hex'),
    );
    for (const table of AI_TABLES) {
      const rows = rowsOf(await f.db.query(`SELECT * FROM ${table}`));
      for (const row of rows) {
        expect(
          JSON.stringify(row, (_k, v) =>
            typeof v === 'bigint' ? String(v) : v,
          ),
        ).not.toContain(secret);
      }
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.tags?.aiCallId).toBe(call.callId);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
  });

  it("the trajectory returns none of the ledger's private columns", async () => {
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    const trajectory = await getRunTrajectory(f.db, f.run.id);
    const text = JSON.stringify(trajectory);
    for (const field of [
      'call_proof',
      'callProof',
      'call_row',
      'callRow',
      'call_rate',
      'callRate',
      'call_usage',
      'callUsage',
    ]) {
      expect(text).not.toContain(field);
    }
    expect(trajectory?.entries[0]?.event?.reservation).toBe('settled');
  });
});
