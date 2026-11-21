/**
 * A tracked call's usage event that reaches the pipeline after the call
 * returned (the provider SDK does not await an async `onUsage`, and an app's
 * own callback runs first) is still the call's (docs/content/ai-runs.md
 * section 6.4, late usage), whether it arrives while the call's capture is
 * still registered or after it was removed:
 *
 * - one usage row per call, and the usage handlers run once;
 * - a call settled from its response or the fallback row takes the
 *   provider's token counts (ledger and run totals);
 * - a call released without usage is charged on the late-usage path.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config.js';
import { getAiRun } from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client.js';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longer than the tracked client keeps a call's capture after it ends. */
const PAST_THE_GRACE_MS = 61_000;

describe('late usage events of tracked calls', () => {
  const dbs: DatabaseInterface[] = [];
  const handled: SmrtAiUsageEvent[] = [];
  /** Usage callbacks the provider started (or will start) without waiting. */
  let pending: Promise<unknown>[] = [];
  /** When set, each call's usage is held back until the test releases it. */
  let held: Array<() => void> | null = null;

  beforeEach(() => {
    config.reset();
    handled.length = 0;
    pending = [];
    held = null;
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (aiConfig: Record<string, unknown>) => {
      const emit = (options: Record<string, unknown>) => {
        const send = () =>
          pending.push(
            (aiConfig.onUsage as (event: unknown) => Promise<void>)({
              provider: 'openai',
              model: 'gpt-4o',
              operation: 'message',
              usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
              duration: 4,
              tags: options.usageTags,
            }),
          );
        // As the SDK does: the usage callback is started, not awaited.
        if (held) held.push(send);
        else send();
      };
      return {
        async message(_text: string, options: Record<string, unknown> = {}) {
          emit(options);
          return 'answer';
        },
        async complete(_text: string, options: Record<string, unknown> = {}) {
          emit(options);
          throw new Error('provider failed after reporting usage');
        },
      };
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    config.reset();
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  async function setup() {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-one',
      ai: {
        type: 'openai',
        model: 'gpt-4o',
        // The app's own async callback: core routes the event after it.
        onUsage: async () => {
          await delay(30);
        },
      } as never,
      usage: {
        handlers: [{ handle: async (event) => void handled.push(event) }],
      },
    });
    const { run, context } = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'late.prompt' },
      { runContext: context },
    );
    return { db, run, client };
  }

  async function settledUsage() {
    await Promise.all(pending);
    // The late settlement or correction runs after the callback returns.
    await delay(50);
  }

  async function ledger(db: DatabaseInterface) {
    return rowsOf(
      await db.query(
        'SELECT prompt_tokens, completion_tokens, total_tokens FROM _smrt_ai_usage',
      ),
    );
  }

  async function reservation(db: DatabaseInterface, runId: string) {
    return rowsOf(
      await db.query(
        "SELECT reservation FROM _smrt_ai_run_events WHERE run_id = $1 AND type = 'call'",
        runId,
      ),
    );
  }

  it('bills a call its provider usage when it arrives after the call returned', async () => {
    const { db, run, client } = await setup();
    expect(await client.message('hello')).toBe('answer');
    await settledUsage();
    expect(handled).toHaveLength(1);
    expect(await ledger(db)).toEqual([
      { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    ]);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
  });

  it('charges a failed call when its usage arrives after the failure', async () => {
    const { db, run, client } = await setup();
    await expect(
      (
        client as unknown as { complete(text: string): Promise<unknown> }
      ).complete('hello'),
    ).rejects.toThrow(/provider failed/);
    await settledUsage();
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 1,
      tokens: 12,
      reservedCalls: 0,
    });
    expect(handled).toHaveLength(1);
    expect(await ledger(db)).toEqual([
      { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    ]);
    expect(await reservation(db, run.id)).toEqual([
      { reservation: 'settled_late' },
    ]);
  });

  it('keeps one row with the provider usage when it arrives after the capture was removed', async () => {
    const { db, run, client } = await setup();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    held = [];
    expect(await client.message('hello')).toBe('answer');
    // The call settled from its response; its capture goes after the grace.
    vi.advanceTimersByTime(PAST_THE_GRACE_MS);
    for (const send of held.splice(0)) send();
    await settledUsage();
    expect(await ledger(db)).toEqual([
      { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    ]);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
    expect(handled).toHaveLength(1);
    // A second delivery of the same usage changes nothing.
    held = null;
  });

  it('charges a failed call once when its usage arrives after the capture was removed', async () => {
    const { db, run, client } = await setup();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    held = [];
    await expect(
      (
        client as unknown as { complete(text: string): Promise<unknown> }
      ).complete('hello'),
    ).rejects.toThrow(/provider failed/);
    vi.advanceTimersByTime(PAST_THE_GRACE_MS);
    const sends = held.splice(0);
    for (const send of sends) send();
    // The provider delivers the same usage twice: charged once.
    for (const send of sends) send();
    await settledUsage();
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 1,
      tokens: 12,
      reservedCalls: 0,
    });
    expect(await ledger(db)).toHaveLength(1);
    expect(await reservation(db, run.id)).toEqual([
      { reservation: 'settled_late' },
    ]);
    expect(handled).toHaveLength(1);
  });
});
