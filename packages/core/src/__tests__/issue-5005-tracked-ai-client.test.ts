/**
 * The tracked client (#5005): one per tenant and database, the run passed
 * explicitly, a prompt key on every call, and runs refused while usage
 * persistence is off.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config.js';
import { AiRunTrackingDisabledError, getAiRun } from '../system/browser';
import {
  AiPromptKeyRequiredError,
  createTrackedAiClient,
} from '../tracked-ai-client.js';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe('createTrackedAiClient (#5005)', () => {
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
          timestamp: new Date(),
          tags: options.usageTags,
        });
        return 'answer';
      },
    }));
  });

  afterEach(async () => {
    config.reset();
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  const ai = { type: 'openai', model: 'gpt-4o' } as const;

  it('writes a run and its calls to its own database and tenant only', async () => {
    const dbA = await memoryDb();
    const dbB = await memoryDb();
    const a = createTrackedAiClient({ db: dbA, tenantId: 'tenant-a', ai });
    const b = createTrackedAiClient({ db: dbB, tenantId: 'tenant-b', ai });

    const runA = await a.openRun({ type: 'turn', promptKey: 'test.prompt' });
    const clientA = await a.client(
      { promptKey: 'test.prompt', templateHash: 'abc123' },
      { runContext: runA.context },
    );
    expect(await clientA.message('hello', { maxTokens: 50 } as never)).toBe(
      'answer',
    );

    // The tags carry the key and hash; the run context never reaches the SDK.
    expect(sent[0]).not.toHaveProperty('runContext');
    expect(sent[0]?.usageTags).toMatchObject({
      promptKey: 'test.prompt',
      templateHash: 'abc123',
      runId: runA.run.id,
    });
    expect(await getAiRun(dbA, runA.run.id)).toMatchObject({
      tenantId: 'tenant-a',
      calls: 1,
      tokens: 12,
    });
    const usageA = rowsOf(
      await dbA.query(
        'SELECT run_id, prompt_key, tenant_id FROM _smrt_ai_usage',
      ),
    );
    expect(usageA).toHaveLength(1);
    expect(usageA[0]).toMatchObject({
      run_id: runA.run.id,
      prompt_key: 'test.prompt',
      tenant_id: 'tenant-a',
    });

    // The other tenant's database holds only its own run, and no usage row.
    const runB = await b.openRun({ type: 'turn', promptKey: 'test.prompt' });
    expect(
      rowsOf(await dbB.query('SELECT id FROM _smrt_ai_runs')).map(
        (row) => row.id,
      ),
    ).toEqual([runB.run.id]);
    expect(rowsOf(await dbB.query('SELECT id FROM _smrt_ai_usage'))).toEqual(
      [],
    );
    expect(await getAiRun(dbB, runB.run.id)).toMatchObject({
      tenantId: 'tenant-b',
    });
    expect(await getAiRun(dbA, runB.run.id)).toBeNull();
  });

  it('refuses a run context of another tenant or database', async () => {
    const dbA = await memoryDb();
    const dbB = await memoryDb();
    const a = createTrackedAiClient({ db: dbA, tenantId: 'tenant-a', ai });
    const b = createTrackedAiClient({ db: dbB, tenantId: 'tenant-b', ai });
    const runB = await b.openRun({ type: 'turn' });
    await expect(
      a.client({ promptKey: 'test.prompt' }, { runContext: runB.context }),
    ).rejects.toThrow(/another tenant or database/);
    const sameDbOtherTenant = createTrackedAiClient({
      db: dbB,
      tenantId: 'tenant-c',
      ai,
    });
    await expect(
      sameDbOtherTenant.client(
        { promptKey: 'test.prompt' },
        { runContext: runB.context },
      ),
    ).rejects.toThrow(/another tenant or database/);
  });

  it('refuses a call set up without a prompt key', async () => {
    const tracked = createTrackedAiClient({
      db: await memoryDb(),
      tenantId: 't',
      ai,
    });
    await expect(
      tracked.client({ promptKey: '' } as never),
    ).rejects.toBeInstanceOf(AiPromptKeyRequiredError);
    await expect(tracked.client({} as never)).rejects.toBeInstanceOf(
      AiPromptKeyRequiredError,
    );
  });

  it('opens no run while usage persistence is off', async () => {
    const tracked = createTrackedAiClient({
      db: await memoryDb(),
      tenantId: 't',
      ai,
      usage: { persist: false },
    });
    await expect(tracked.openRun({ type: 'turn' })).rejects.toBeInstanceOf(
      AiRunTrackingDisabledError,
    );
  });

  it('settles a call from the response when the client reports no usage event', async () => {
    getAIMock.mockImplementation(async () => ({
      async chat() {
        return {
          content: 'hi',
          model: 'gpt-4o',
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        };
      },
    }));
    const db = await memoryDb();
    const tracked = createTrackedAiClient({ db, tenantId: 't', ai });
    const run = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'test.prompt' },
      { runContext: run.context },
    );
    await (
      client as unknown as { chat: (m: unknown[]) => Promise<unknown> }
    ).chat([{ role: 'user', content: 'hello' }]);
    expect(await getAiRun(db, run.run.id)).toMatchObject({
      calls: 1,
      tokens: 5,
    });
  });

  it("records a host-built client's calls under its label, uncosted", async () => {
    const db = await memoryDb();
    const built = {
      async chat() {
        return {
          content: 'hi',
          model: 'plan-model-reported',
          usage: { totalTokens: 9 },
        };
      },
      embed() {
        throw new Error('no embeddings');
      },
    };
    const tracked = createTrackedAiClient({
      db,
      tenantId: 't',
      ai: built as never,
      label: { provider: 'chatgpt', model: 'plan-model' },
    });
    const run = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'test.prompt' },
      { runContext: run.context },
    );
    await (
      client as unknown as { chat: (m: unknown[]) => Promise<unknown> }
    ).chat([{ role: 'user', content: 'hello' }]);
    expect(
      rowsOf(
        await db.query(
          'SELECT provider, model, total_tokens, estimated_cost FROM _smrt_ai_usage',
        ),
      ),
    ).toEqual([
      {
        provider: 'chatgpt',
        model: 'plan-model-reported',
        total_tokens: 9,
        estimated_cost: null,
      },
    ]);
    expect(await getAiRun(db, run.run.id)).toMatchObject({
      calls: 1,
      tokens: 9,
      uncostedCalls: 1,
    });
  });
});
