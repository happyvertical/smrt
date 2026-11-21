/**
 * Billing tags on tier clients (#5489): every call a tier client sends (a
 * tracked client's, inside a run or not, a raw `getAiClient(tier)` client's)
 * carries its binding's `source` on its usage row, over whatever the caller
 * tagged, so hosted spend meters it.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config.js';
import {
  type InferenceResolver,
  type InferenceTargetSource,
  setInferenceResolver,
} from '../inference.js';
import { setInferenceGate } from '../inference-gate.js';
import { resolveInferenceTarget } from '../inference-target.js';
import { createTrackedAiClient } from '../tracked-ai-client.js';

const BASE_AI = { provider: 'openai', apiKey: 'sk-base', model: 'base-model' };

function binding(source: InferenceTargetSource): InferenceResolver {
  return {
    resolve(request) {
      return {
        tierResolved:
          request.tier === 'auto' ? 'good' : (request.tier as 'good'),
        via: 'resolver',
        target: {
          provider: 'openai',
          baseUrl: `https://${source}.example/v1`,
          apiKey: `sk-${source}`,
          model: 'gpt-4o',
          source,
        },
      };
    },
  };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function usageTags(
  db: DatabaseInterface,
): Promise<Array<Record<string, string>>> {
  const rows = rowsOf(
    await db.query(
      "SELECT tags FROM _smrt_ai_usage WHERE operation <> 'blocked' ORDER BY created_at, id",
    ),
  );
  return rows.map((row) => JSON.parse(String(row.tags ?? '{}')));
}

describe('billing tags on tier clients (#5489)', () => {
  const sent: Record<string, unknown>[] = [];
  const dbs: DatabaseInterface[] = [];

  async function memoryDb(): Promise<DatabaseInterface> {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    return db;
  }

  beforeEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceGate(undefined);
    sent.length = 0;
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (aiConfig: Record<string, unknown>) => ({
      async message(_text: string, options: Record<string, unknown> = {}) {
        sent.push(options);
        await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
          provider: 'openai',
          model: 'gpt-4o',
          operation: 'message',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          duration: 3,
          tags: options.usageTags,
        });
        return 'answer';
      },
    }));
  });

  afterEach(async () => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceGate(undefined);
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  it('tags a tracked call outside a run with its hosted binding', async () => {
    setInferenceResolver(binding('hosted'));
    const db = await memoryDb();
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: BASE_AI,
    });
    const client = await tracked.client({
      promptKey: 'test.billing',
      tier: 'good',
    });
    await client.message('hello');
    expect(sent[0]?.usageTags).toMatchObject({
      source: 'hosted',
      promptKey: 'test.billing',
    });
    expect(await usageTags(db)).toEqual([
      expect.objectContaining({ source: 'hosted', promptKey: 'test.billing' }),
    ]);
  });

  it('tags a tracked call of a run, settled with its usage row', async () => {
    setInferenceResolver(binding('hosted'));
    const db = await memoryDb();
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: BASE_AI,
    });
    const run = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'test.billing', tier: 'great' },
      { runContext: run.context },
    );
    await client.message('hello', { maxTokens: 64 } as never);
    const [row] = rowsOf(
      await db.query('SELECT run_id, tags FROM _smrt_ai_usage'),
    );
    expect(row).toMatchObject({ run_id: run.run.id });
    expect(JSON.parse(String(row?.tags))).toMatchObject({
      source: 'hosted',
      runId: run.run.id,
    });
  });

  it("keeps the binding's tags over the caller's own", async () => {
    setInferenceResolver(binding('hosted'));
    const db = await memoryDb();
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: BASE_AI,
    });
    const client = await tracked.client({
      promptKey: 'test.billing',
      tier: 'good',
      usageTags: { source: 'byo', feature: 'kept' },
    });
    await client.message('hello', {
      usageTags: { source: 'local' },
    } as never);
    expect(await usageTags(db)).toEqual([
      expect.objectContaining({ source: 'hosted', feature: 'kept' }),
    ]);
  });

  it('tags a byo binding as byo, and leaves an untiered call untagged', async () => {
    setInferenceResolver(binding('byo'));
    const db = await memoryDb();
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: BASE_AI,
    });
    await (
      await tracked.client({ promptKey: 'test.billing', tier: 'good' })
    ).message('tiered');
    await (await tracked.client({ promptKey: 'test.billing' })).message(
      'untiered',
    );
    const tags = await usageTags(db);
    expect(tags[0]).toMatchObject({ source: 'byo' });
    expect(tags[1]).not.toHaveProperty('source');
  });

  it("records a raw site's hosted binding over the site's own source tag", async () => {
    setInferenceResolver(binding('hosted'));
    const handle = vi.fn(async (_event: unknown) => {});
    config({ usage: { handlers: [{ handle }] } });
    const resolved = await resolveInferenceTarget({
      base: BASE_AI,
      className: 'ChatRoute',
      tenantId: 'tenant-a',
      usage: { tags: { source: 'app', feature: 'kept' } },
    });
    expect(resolved.usageTags).toMatchObject({ source: 'hosted' });
    const onUsage = (resolved.options as { onUsage: (e: unknown) => unknown })
      .onUsage;
    await onUsage({
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'message',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      duration: 1,
    });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      tags: { source: 'hosted', feature: 'kept' },
    });
  });
});
