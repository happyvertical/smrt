/**
 * The tracked client is scoped to one tenant and database
 * (docs/content/ai-runs.md section 3): a run context passed on a single call
 * is held to the same rule as one bound at `client()`, the context's run
 * row must belong to the client's tenant, and a call of a run is billed to
 * the run's tenant whatever the ambient tenant is.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { setAiUsageTenantResolver } from '../adapters/ai-usage-recorder.js';
import { config } from '../config.js';
import {
  AiRunNotFoundError,
  AiRunStoppedError,
  finishAiRun,
  getAiRun,
} from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client.js';
import {
  hasTenantPredicate,
  recordStatements,
} from './fixtures/ai-run-test-db';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const ai = { type: 'openai', model: 'gpt-4o' } as const;
const prompt = { promptKey: 'scope.prompt' };

describe('tracked client scope', () => {
  const sent: Record<string, unknown>[] = [];
  const dbs: DatabaseInterface[] = [];

  async function memoryDb(): Promise<DatabaseInterface> {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    return db;
  }

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
          tags: options.usageTags,
        });
        return 'answer';
      },
      async *stream(_text: string, options: Record<string, unknown> = {}) {
        sent.push(options);
        yield 'chunk';
      },
    }));
  });

  afterEach(async () => {
    config.reset();
    setAiUsageTenantResolver(undefined);
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  it('refuses a per-call run context of another tenant before anything is reserved or sent', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const { run, context } = await two.openRun({ type: 'turn' });
    const client = await one.client(prompt);

    await expect(
      client.message('hello', { runContext: context } as never),
    ).rejects.toThrow(/another tenant or database/);
    // A context that claims this client's tenant for the other tenant's run.
    await expect(
      client.message('hello', {
        runContext: { ...context, tenantId: 'tenant-one' },
      } as never),
    ).rejects.toThrow(/another tenant or database/);
    // Streams are held to the same rule.
    const stream = (
      client as unknown as {
        stream(input: string, options: unknown): AsyncIterable<unknown>;
      }
    ).stream('hello', { runContext: context });
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // drain
        }
      })(),
    ).rejects.toThrow(/another tenant or database/);

    expect(sent).toHaveLength(0);
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 0,
      reservedCalls: 0,
    });
    expect(rowsOf(await db.query('SELECT id FROM _smrt_ai_usage'))).toEqual([]);
  });

  it('looks a context run up in its own tenant only', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const { run, context } = await two.openRun({ type: 'turn' });
    const client = await one.client(prompt);
    const unscoped: string[] = [];
    const restore = recordStatements(db, (sql, params) => {
      if (params.includes(run.id) && !hasTenantPredicate(sql)) {
        unscoped.push(sql);
      }
    });
    await expect(
      client.message('hello', {
        runContext: { ...context, tenantId: 'tenant-one' },
      } as never),
    ).rejects.toThrow(/another tenant or database/);
    restore();
    expect(unscoped).toEqual([]);
  });

  it('refuses at client() a bound context naming another tenant run', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const { context } = await two.openRun({ type: 'turn' });
    await expect(
      one.client(prompt, {
        runContext: { ...context, tenantId: 'tenant-one' },
      }),
    ).rejects.toThrow(/another tenant or database/);
  });

  it('refuses a per-call run context of another database', async () => {
    const db = await memoryDb();
    const otherDb = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const elsewhere = createTrackedAiClient({
      db: otherDb,
      tenantId: 'tenant-one',
      ai,
    });
    const { context } = await elsewhere.openRun({ type: 'turn' });
    const client = await one.client(prompt);
    await expect(
      client.message('hello', { runContext: context } as never),
    ).rejects.toThrow(/another tenant or database/);
    expect(sent).toHaveLength(0);
  });

  it('takes a per-call run context of its own tenant (control)', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const { run, context } = await one.openRun({ type: 'turn' });
    const client = await one.client(prompt);
    expect(
      await client.message('hello', { runContext: context } as never),
    ).toBe('answer');
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
  });

  it('uses the bound context as validated, even if the caller changes it afterwards', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const own = await one.openRun({ type: 'turn' });
    const foreign = await two.openRun({ type: 'turn' });
    const context = { ...own.context };
    const client = await one.client(prompt, { runContext: context });
    context.runId = foreign.run.id;
    await client.message('hello');
    expect(await getAiRun(db, own.run.id)).toMatchObject({ calls: 1 });
    expect(await getAiRun(db, foreign.run.id)).toMatchObject({ calls: 0 });
  });

  it('uses a per-call context as validated, even if the caller changes it while it is checked', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const own = await one.openRun({ type: 'turn' });
    const foreign = await two.openRun({ type: 'turn' });
    const client = await one.client(prompt);
    const context = { ...own.context };
    const pending = client.message('hello', { runContext: context } as never);
    context.runId = foreign.run.id;
    await pending;
    expect(await getAiRun(db, own.run.id)).toMatchObject({ calls: 1 });
    expect(await getAiRun(db, foreign.run.id)).toMatchObject({ calls: 0 });
  });

  it('reads a per-call run context once, so the context checked is the context used', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const own = await one.openRun({ type: 'turn' });
    const foreign = await two.openRun({ type: 'turn' });
    const client = await one.client(prompt);
    // Options whose run context answers differently on each read.
    const shifting = (answers: unknown[]) => {
      let reads = 0;
      return {
        get runContext() {
          const answer = answers[Math.min(reads, answers.length - 1)];
          reads += 1;
          return answer;
        },
      };
    };

    await client.message(
      'hello',
      shifting([undefined, foreign.context]) as never,
    );
    await client.message(
      'hello',
      shifting([own.context, foreign.context]) as never,
    );
    const stream = (
      client as unknown as {
        stream(input: string, options: unknown): AsyncIterable<unknown>;
      }
    ).stream('hello', shifting([undefined, foreign.context]));
    for await (const _chunk of stream) {
      // drain
    }

    expect(sent).toHaveLength(3);
    expect(sent[0]?.runContext).toBeUndefined();
    expect(sent[2]?.runContext).toBeUndefined();
    expect(await getAiRun(db, own.run.id)).toMatchObject({ calls: 1 });
    expect(await getAiRun(db, foreign.run.id)).toMatchObject({
      calls: 0,
      reservedCalls: 0,
    });
    expect(
      rowsOf(
        await db.query(
          'SELECT id FROM _smrt_ai_usage WHERE run_id = $1',
          foreign.run.id,
        ),
      ),
    ).toEqual([]);
  });

  it('takes a per-call run context an options object exposes through a prototype accessor, read once', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const own = await one.openRun({ type: 'turn' });
    const stopped = await one.openRun({ type: 'turn' });
    await finishAiRun(db, stopped.run.id, { status: 'done' });
    const client = await one.client(prompt);
    let reads = 0;
    class CallOptions {
      readonly temperature = 0.2;
      constructor(private readonly context: unknown) {}
      get runContext() {
        reads += 1;
        return this.context;
      }
    }

    await client.message('hello', new CallOptions(own.context) as never);
    expect(reads).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.temperature).toBe(0.2);
    expect(await getAiRun(db, own.run.id)).toMatchObject({
      calls: 1,
      tokens: 12,
    });

    // A finished run's context is refused before anything is sent.
    await expect(
      client.message('hello', new CallOptions(stopped.context) as never),
    ).rejects.toBeInstanceOf(AiRunStoppedError);
    expect(sent).toHaveLength(1);
    expect(await getAiRun(db, stopped.run.id)).toMatchObject({ calls: 0 });
  });

  it('keeps the database it was built on when the caller changes its options', async () => {
    const db = await memoryDb();
    const replacement = await memoryDb();
    const options = { db, tenantId: 'tenant-one', ai } as {
      db: DatabaseInterface;
      tenantId: string;
      ai: typeof ai;
    };
    const one = createTrackedAiClient(options);
    const elsewhere = createTrackedAiClient({
      db: replacement,
      tenantId: 'tenant-one',
      ai,
    });
    const { context: foreignContext } = await elsewhere.openRun({
      type: 'turn',
    });
    options.db = replacement;
    expect(one.db).toBe(db);
    const { run, context } = await one.openRun({ type: 'turn' });
    expect(context.db).toBe(db);
    expect(await getAiRun(db, run.id)).not.toBeNull();
    const client = await one.client(prompt);
    // A context of the replacement database is still another database.
    await expect(
      client.message('hello', { runContext: foreignContext } as never),
    ).rejects.toThrow(/another tenant or database/);
    expect(sent).toHaveLength(0);
    await client.message('hello', { runContext: context } as never);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1 });
  });

  it('never bills a run whose id was pruned and reused by another tenant after binding', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const { run, context } = await one.openRun({ type: 'turn' });
    const client = await one.client(prompt, { runContext: context });
    // The id now names a run of tenant-two (a link an older core wrote
    // without the run id registry, which refuses this reopen through
    // openAiRun).
    await db.query('DELETE FROM _smrt_ai_run_events WHERE run_id = $1', run.id);
    await db.query(
      "UPDATE _smrt_ai_runs SET tenant_id = 'tenant-two' WHERE id = $1",
      run.id,
    );
    await expect(client.message('hello')).rejects.toBeInstanceOf(
      AiRunNotFoundError,
    );
    expect(sent).toHaveLength(0);
    expect(await getAiRun(db, run.id)).toMatchObject({
      tenantId: 'tenant-two',
      calls: 0,
      reservedCalls: 0,
    });
    expect(rowsOf(await db.query('SELECT id FROM _smrt_ai_usage'))).toEqual([]);
  });

  it('bills a global client run call to the global scope inside an ambient tenant', async () => {
    const db = await memoryDb();
    setAiUsageTenantResolver(() => 'ambient-tenant');
    const global = createTrackedAiClient({ db, tenantId: null, ai });
    const { run, context } = await global.openRun({ type: 'turn' });
    expect(run.tenantId).toBeNull();
    const client = await global.client(prompt, { runContext: context });
    await client.message('hello');
    const rows = rowsOf(
      await db.query('SELECT run_id, tenant_id FROM _smrt_ai_usage'),
    );
    expect(rows).toEqual([{ run_id: run.id, tenant_id: null }]);
  });

  it('a global client stamps tenantId null on a context that omits it', async () => {
    const db = await memoryDb();
    setAiUsageTenantResolver(() => 'ambient-tenant');
    const global = createTrackedAiClient({ db, tenantId: null, ai });
    const { run } = await global.openRun({ type: 'turn' });
    // A context written without its tenant (an older serialized payload).
    const bare = { runId: run.id, db };
    const unscoped: string[] = [];
    const restore = recordStatements(db, (sql, params) => {
      if (
        sql.startsWith('SELECT') &&
        sql.includes('FROM _smrt_ai_runs') &&
        params.includes(run.id) &&
        !hasTenantPredicate(sql)
      ) {
        unscoped.push(sql);
      }
    });
    const client = await global.client(prompt, { runContext: bare });
    await client.message('hello');
    restore();
    // Accounting found the run in the global scope and never looked its
    // tenant up.
    expect(unscoped).toEqual([]);
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 1,
      tenantId: null,
    });
    expect(
      rowsOf(await db.query('SELECT run_id, tenant_id FROM _smrt_ai_usage')),
    ).toEqual([{ run_id: run.id, tenant_id: null }]);
  });

  it('refuses a context declaring another tenant (control)', async () => {
    const db = await memoryDb();
    const global = createTrackedAiClient({ db, tenantId: null, ai });
    const { run } = await global.openRun({ type: 'turn' });
    await expect(
      global.client(prompt, {
        runContext: { runId: run.id, db, tenantId: 'tenant-one' },
      }),
    ).rejects.toThrow(/another tenant or database/);
  });
});
