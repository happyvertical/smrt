/**
 * Run tracking through SmrtClass (#5005): a client from
 * `getAiClient(tier, { runTracking: true })` tracks the calls that carry a
 * `runContext`. The usage event is written with the settlement, the
 * persistence handler finds the row already there, the other handlers run
 * after the commit, and the run is charged once. A store without usage
 * persistence refuses to open a run.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import {
  AiRunTrackingDisabledError,
  getAiRun,
  openAiRun,
} from '../system/browser';

class RunProbe extends SmrtClass {
  async init(): Promise<this> {
    return this.initialize();
  }
  store() {
    return this.aiRunStore();
  }
  client(runTracking: boolean) {
    return this.getAiClient(undefined, { runTracking });
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe('SmrtClass run tracking (#5005)', () => {
  const sent: Record<string, unknown>[] = [];
  beforeEach(() => {
    config.reset();
    sent.length = 0;
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (aiConfig: Record<string, unknown>) => ({
      async message(_text: string, options: Record<string, unknown> = {}) {
        sent.push(options);
        await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
          provider: 'openai',
          model: 'gpt-4o',
          operation: 'message',
          usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
          duration: 4,
          timestamp: new Date(),
          tags: options.usageTags,
        });
        return 'answer';
      },
    }));
  });
  afterEach(() => {
    config.reset();
  });

  it('charges a tracked call once and runs the handlers after its settlement', async () => {
    const seen: number[] = [];
    let db: DatabaseInterface | null | undefined;
    const handler = {
      async handle(event: SmrtAiUsageEvent) {
        if (!event.tags?.aiCallId || !db) return;
        seen.push(
          rowsOf(
            await db.query(
              'SELECT id FROM _smrt_ai_usage WHERE id = $1',
              event.tags.aiCallId,
            ),
          ).length,
        );
      },
    };
    const probe = new RunProbe({
      db: ':memory:',
      ai: { provider: 'openai', model: 'gpt-4o' },
      usage: { handlers: [handler] },
    } as never);
    await probe.init();
    const store = await probe.store();
    expect(store.usageTracking).toBe(true);
    db = store.db;
    const run = await openAiRun(store, {
      type: 'turn',
      budget: { maxTokens: 10_000 },
    });

    const plain = await probe.client(false);
    expect(await plain.message('hi', { temperature: 0 } as never)).toBe(
      'answer',
    );
    expect(sent[0]).toEqual({ temperature: 0 });

    const tracked = await probe.client(true);
    expect(
      await tracked.message('hello', {
        runContext: { runId: run.id, db: store.db },
        maxTokens: 50,
      } as never),
    ).toBe('answer');
    expect(sent[1]).not.toHaveProperty('runContext');
    expect(sent[1]?.maxTokens).toBe(50);
    expect(seen).toEqual([1]);
    const rows = rowsOf(
      await (store.db as DatabaseInterface).query(
        'SELECT id, call_id, run_id, total_tokens FROM _smrt_ai_usage WHERE run_id = $1',
        run.id,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.call_id).toBe(rows[0]?.id);
    expect(await getAiRun(store.db as DatabaseInterface, run.id)).toMatchObject(
      {
        calls: 1,
        tokens: 12,
        reservedCalls: 0,
        reservedTokens: 0,
      },
    );
  });

  it('writes every settlement of an open run after tracking was switched off', async () => {
    const opener = new RunProbe({
      db: ':memory:',
      ai: { provider: 'openai', model: 'gpt-4o' },
    } as never);
    await opener.init();
    const store = await opener.store();
    const run = await openAiRun(store, { type: 'turn' });
    // The check is made only when a run opens: a client whose usage is now
    // off still records the calls of the run it was handed.
    const later = new RunProbe({
      db: ':memory:',
      ai: { provider: 'openai', model: 'gpt-4o' },
      usage: { enabled: false, persist: false },
    } as never);
    await later.init();
    expect((await later.store()).usageTracking).toBe(false);
    const tracked = await later.client(true);
    await tracked.message('hello', {
      runContext: { runId: run.id, db: store.db },
    } as never);
    const rows = rowsOf(
      await (store.db as DatabaseInterface).query(
        'SELECT total_tokens FROM _smrt_ai_usage WHERE run_id = $1',
        run.id,
      ),
    );
    expect(rows.map((row) => Number(row.total_tokens))).toEqual([12]);
    expect(await getAiRun(store.db as DatabaseInterface, run.id)).toMatchObject(
      { calls: 1, tokens: 12 },
    );
    // A new run on the switched-off store is refused.
    await expect(
      openAiRun(await later.store(), { type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunTrackingDisabledError);
  });

  it('refuses to open a run while usage persistence is off', async () => {
    const probe = new RunProbe({
      db: ':memory:',
      ai: { provider: 'openai', model: 'gpt-4o' },
      usage: { persist: false },
    } as never);
    await probe.init();
    const store = await probe.store();
    expect(store.usageTracking).toBe(false);
    await expect(openAiRun(store, { type: 'turn' })).rejects.toBeInstanceOf(
      AiRunTrackingDisabledError,
    );
  });
});
