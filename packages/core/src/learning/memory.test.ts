/**
 * Unit tests for LearningMemory (#1886).
 *
 * Uses a real in-memory SQLite database with the `_smrt_contexts` /
 * `_smrt_embeddings` system tables; only the AI embedding boundary is mocked.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { EmbeddingProvider } from '../embeddings/provider';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { LearningMemory, type LearningSemanticSearch } from './memory';

const OWNER_CLASS = 'TestLearner';

async function readRow(
  db: DatabaseInterface,
  ownerId: string,
  scope: string,
  key: string,
) {
  return db.get('_smrt_contexts', {
    owner_class: OWNER_CLASS,
    owner_id: ownerId,
    scope,
    key,
    version: 1,
  });
}

describe('LearningMemory', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ includeSystemTables: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeMemory(ownerId = 'owner-1', overrides = {}) {
    return new LearningMemory({
      db,
      ownerClass: OWNER_CLASS,
      ownerId,
      ...overrides,
    });
  }

  describe('capture()', () => {
    it('seeds a new memory at successConfidence and increments success_count on success', async () => {
      const memory = makeMemory();

      const record = await memory.capture(
        { scope: 'parser/acme', key: 'invoice', value: { selector: '.total' } },
        { success: true },
      );

      expect(record).not.toBeNull();
      expect(record?.confidence).toBeCloseTo(0.9, 5);
      expect(record?.successCount).toBe(1);
      expect(record?.failureCount).toBe(0);

      const row = await readRow(db, 'owner-1', 'parser/acme', 'invoice');
      expect(Number(row?.confidence)).toBeCloseTo(0.9, 5);
      expect(Number(row?.success_count)).toBe(1);
      expect(Number(row?.failure_count)).toBe(0);
    });

    it('raises confidence and increments success_count on repeat success', async () => {
      const memory = makeMemory();
      const episode = {
        scope: 'parser/acme',
        key: 'invoice',
        value: { selector: '.total' },
      };

      const first = await memory.capture(episode, { success: true });
      const second = await memory.capture(episode, { success: true });

      // 0.9 -> 0.9 + 0.5*(1 - 0.9) = 0.95
      expect(second?.confidence).toBeGreaterThan(first?.confidence ?? 0);
      expect(second?.confidence).toBeCloseTo(0.95, 5);
      expect(second?.successCount).toBe(2);
      expect(second?.failureCount).toBe(0);
    });

    it('lowers confidence and increments failure_count on failure', async () => {
      const memory = makeMemory();
      const episode = {
        scope: 'parser/acme',
        key: 'invoice',
        value: { selector: '.total' },
      };

      await memory.capture(episode, { success: true }); // 0.9
      const failed = await memory.capture(episode, {
        success: false,
        error: 'no match',
      });

      // 0.9 -> 0.9 + 0.5*(0.3 - 0.9) = 0.6
      expect(failed?.confidence).toBeCloseTo(0.6, 5);
      expect(failed?.confidence).toBeLessThan(0.7);
      expect(failed?.successCount).toBe(1);
      expect(failed?.failureCount).toBe(1);
    });

    it('drops a memory below the reuse floor in a single failure from any confident value', async () => {
      const memory = makeMemory();
      const episode = { scope: 's', key: 'k', value: 'v' };

      // Climb confidence high with repeated successes.
      for (let i = 0; i < 5; i++) {
        await memory.capture(episode, { success: true });
      }
      const beforeFail = await readRow(db, 'owner-1', 's', 'k');
      expect(Number(beforeFail?.confidence)).toBeGreaterThan(0.9);

      const failed = await memory.capture(episode, { success: false });
      expect(failed?.confidence).toBeLessThan(0.7);
    });

    it('retains a failed first attempt at low confidence for self-correction context', async () => {
      const memory = makeMemory();

      const record = await memory.capture(
        { scope: 's', key: 'k', value: 'bad-attempt' },
        { success: false, error: 'threw' },
      );

      expect(record?.confidence).toBeCloseTo(0.3, 5);
      expect(record?.failureCount).toBe(1);

      const row = await readRow(db, 'owner-1', 's', 'k');
      expect(row).not.toBeNull();
      expect(JSON.parse(String(row?.metadata)).lastError).toBe('threw');
    });

    it('returns null when there is no existing memory and no value to seed', async () => {
      const memory = makeMemory();
      const record = await memory.capture(
        { scope: 's', key: 'missing' },
        { success: true },
      );
      expect(record).toBeNull();
    });

    it('supports a numeric metric outcome (positive => success)', async () => {
      const memory = makeMemory();
      const episode = { scope: 's', key: 'k', value: 'v' };

      await memory.capture(episode, { success: true });
      const up = await memory.capture(episode, { metric: 5 });
      expect(up?.successCount).toBe(2);

      const down = await memory.capture(episode, { metric: -3 });
      expect(down?.failureCount).toBe(1);
      expect(down?.confidence).toBeLessThan(up?.confidence ?? 1);
    });
  });

  describe('recall() — keyed context arm', () => {
    it('returns a confident memory by key', async () => {
      const memory = makeMemory();
      await memory.capture(
        { scope: 'parser/acme', key: 'invoice', value: { selector: '.total' } },
        { success: true },
      );

      const results = await memory.recall('parser/acme', { key: 'invoice' });
      expect(results).toHaveLength(1);
      expect(results[0].value).toEqual({ selector: '.total' });
      expect(results[0].source).toBe('context');
      expect(results[0].confidence).toBeCloseTo(0.9, 5);
    });

    it('does not return a memory decayed below the reuse floor', async () => {
      const memory = makeMemory();
      const episode = { scope: 's', key: 'k', value: 'v' };
      await memory.capture(episode, { success: true }); // 0.9
      await memory.capture(episode, { success: false }); // 0.6 (< 0.7)

      const results = await memory.recall('s', { key: 'k' });
      expect(results).toHaveLength(0);
    });

    it('honours an explicit minConfidence override', async () => {
      const memory = makeMemory();
      const episode = { scope: 's', key: 'k', value: 'v' };
      await memory.capture(episode, { success: true }); // 0.9
      await memory.capture(episode, { success: false }); // 0.6

      // Below the default 0.7 floor, but retrievable at a lower floor.
      const results = await memory.recall('s', {
        key: 'k',
        minConfidence: 0.5,
      });
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBeCloseTo(0.6, 5);
    });

    it('recalls all confident keys in a scope when no key is given', async () => {
      const memory = makeMemory();
      await memory.capture(
        { scope: 's', key: 'a', value: 1 },
        { success: true },
      );
      await memory.capture(
        { scope: 's', key: 'b', value: 2 },
        { success: true },
      );
      await memory.capture(
        { scope: 's', key: 'c', value: 3 },
        { success: false },
      ); // 0.3

      const results = await memory.recall('s');
      const keys = results.map((r) => r.key).sort();
      expect(keys).toEqual(['a', 'b']); // 'c' decayed below floor
    });

    it('falls back up the scope hierarchy when no match at the leaf scope', async () => {
      const memory = makeMemory();
      await memory.capture(
        { scope: 'parser', key: 'default', value: 'fallback' },
        { success: true },
      );

      const results = await memory.recall('parser/acme/invoice', {
        key: 'default',
        includeAncestors: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe('fallback');
    });

    it('refreshes last_used_at on recall (wires the previously-dead column)', async () => {
      const memory = makeMemory();
      await memory.capture(
        { scope: 's', key: 'k', value: 'v' },
        { success: true },
      );

      const before = await readRow(db, 'owner-1', 's', 'k');
      const future = new Date(Date.now() + 60_000);

      await memory.recall('s', { key: 'k', now: future });

      const after = await readRow(db, 'owner-1', 's', 'k');
      expect(new Date(String(after?.last_used_at)).getTime()).toBeGreaterThan(
        new Date(String(before?.last_used_at)).getTime(),
      );
    });

    it('excludes expired memories', async () => {
      const memory = makeMemory();
      await memory.capture(
        {
          scope: 's',
          key: 'k',
          value: 'v',
          expiresAt: new Date(Date.now() - 1000),
        },
        { success: true },
      );

      const results = await memory.recall('s', { key: 'k' });
      expect(results).toHaveLength(0);
    });

    it('applies optional time-based decay so stale memory drops below the floor', async () => {
      const memory = makeMemory('owner-1', {
        config: { decayHalfLifeMs: 1000 },
      });
      await memory.capture(
        { scope: 's', key: 'k', value: 'v' },
        { success: true },
      ); // 0.9

      // Fresh: still confident.
      const fresh = await memory.recall('s', { key: 'k', now: new Date() });
      expect(fresh).toHaveLength(1);

      // 4 half-lives later: 0.9 * 0.5^4 = 0.056 < 0.7.
      const stale = await memory.recall('s', {
        key: 'k',
        now: new Date(Date.now() + 4000),
      });
      expect(stale).toHaveLength(0);
    });
  });

  describe('recall() — owner isolation (tenant scoping)', () => {
    it('never returns another owner’s memory', async () => {
      const ownerA = makeMemory('tenant-a-agent');
      const ownerB = makeMemory('tenant-b-agent');

      await ownerA.capture(
        { scope: 's', key: 'k', value: 'a-secret' },
        { success: true },
      );

      const bResults = await ownerB.recall('s', { key: 'k' });
      expect(bResults).toHaveLength(0);

      const aResults = await ownerA.recall('s', { key: 'k' });
      expect(aResults).toHaveLength(1);
      expect(aResults[0].value).toBe('a-secret');
    });
  });

  describe('recall() — semantic arm (union)', () => {
    it('unions keyed-context results with injected semantic search results', async () => {
      const searcher = vi.fn(async () => [
        { id: 'obj-1', _similarity: 0.92, title: 'Relevant doc' },
        { id: 'obj-2', _similarity: 0.81, title: 'Also relevant' },
      ]);
      const memory = makeMemory('owner-1', { semanticSearch: searcher });

      await memory.capture(
        { scope: 'notes', key: 'k1', value: 'kept note' },
        { success: true },
      );

      const results = await memory.recall('notes', {
        key: 'k1',
        query: 'find relevant docs',
      });

      const sources = results.map((r) => r.source).sort();
      expect(sources).toEqual(['context', 'semantic', 'semantic']);
      // Sorted by confidence/similarity desc: the 0.92 semantic hit leads.
      expect(results[0].source).toBe('semantic');
      expect(results[0].similarity).toBeCloseTo(0.92, 5);
    });

    it('threads tenantId into the semantic searcher where-clause', async () => {
      const searcher = vi.fn(
        async () => [],
      ) as unknown as LearningSemanticSearch;
      const memory = makeMemory('owner-1', {
        tenantId: 'tenant-42',
        semanticSearch: searcher,
      });

      await memory.recall('notes', { query: 'anything' });

      expect(searcher).toHaveBeenCalledWith(
        'anything',
        expect.objectContaining({ where: { tenant_id: 'tenant-42' } }),
      );
    });

    it('does not run semantic search without a query', async () => {
      const searcher = vi.fn(
        async () => [],
      ) as unknown as LearningSemanticSearch;
      const memory = makeMemory('owner-1', { semanticSearch: searcher });

      await memory.recall('notes', { key: 'k1' });
      expect(searcher).not.toHaveBeenCalled();
    });

    it('applies the confidence floor to the semantic arm by default', async () => {
      const searcher = vi.fn(
        async () => [],
      ) as unknown as LearningSemanticSearch;
      const memory = makeMemory('owner-1', {
        semanticSearch: searcher,
        config: { minConfidence: 0.75 },
      });

      // No explicit minSimilarity → the reuse floor is applied to semantic hits
      // too, so a low-similarity hit can't be reused below the confidence floor.
      await memory.recall('notes', { query: 'q' });
      expect(searcher).toHaveBeenCalledWith(
        'q',
        expect.objectContaining({ minSimilarity: 0.75 }),
      );

      // An explicit minSimilarity still overrides the floor.
      await memory.recall('notes', { query: 'q', minSimilarity: 0.4 });
      expect(searcher).toHaveBeenLastCalledWith(
        'q',
        expect.objectContaining({ minSimilarity: 0.4 }),
      );
    });

    it('filters semantic hits by minSimilarity', async () => {
      const searcher = vi.fn(
        async (
          _q: string,
          opts: { minSimilarity?: number },
        ): Promise<Array<{ id: string; _similarity: number }>> => {
          const all = [
            { id: 'hi', _similarity: 0.95 },
            { id: 'lo', _similarity: 0.4 },
          ];
          return all.filter((h) => h._similarity >= (opts.minSimilarity ?? 0));
        },
      );
      const memory = makeMemory('owner-1', { semanticSearch: searcher });

      const results = await memory.recall('notes', {
        query: 'q',
        minSimilarity: 0.5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('hi');
    });
  });
});

// -----------------------------------------------------------------------------
// Real embedding composition — proves the semantic arm works over stored
// `_smrt_embeddings` via SmrtCollection.semanticSearch, with only the AI
// embedding boundary mocked.
// -----------------------------------------------------------------------------

@smrt({
  embeddings: {
    fields: ['content'],
    autoGenerate: false,
  },
})
class LearningNote extends SmrtObject {
  content: string = '';
}

class LearningNoteCollection extends SmrtCollection<LearningNote> {
  static readonly _itemClass = LearningNote;
}

function topicEmbedding(text: string): number[] {
  const t = text.toLowerCase();
  return [
    t.includes('invoice') || t.includes('billing') ? 0.9 : 0.1,
    t.includes('sport') || t.includes('game') ? 0.9 : 0.1,
    0.2,
  ];
}

describe('LearningMemory — real embedding composition', () => {
  let collection: LearningNoteCollection;

  beforeEach(async () => {
    ObjectRegistry.registerCollection('LearningNote', LearningNoteCollection);

    collection = await LearningNoteCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
      ai: {
        embed: async (texts: string | string[]) => {
          const arr = Array.isArray(texts) ? texts : [texts];
          return { embeddings: arr.map(topicEmbedding) };
        },
      } as any,
    });

    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
      async (texts: string | string[]) => {
        const arr = Array.isArray(texts) ? texts : [texts];
        return arr.map(topicEmbedding);
      },
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      'test-model',
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getDimensions').mockReturnValue(3);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recalls a semantically-similar stored note through the semantic arm', async () => {
    for (const content of [
      'How to reconcile an overdue invoice and billing dispute',
      'The football game went into overtime last night',
    ]) {
      const note = await collection.create({ content });
      await note.save();
      await note.generateEmbeddings();
    }

    const memory = new LearningMemory({
      db: collection.db,
      ownerClass: 'LearningNote',
      ownerId: '__collection__',
      semanticSearch: (q, opts) => collection.semanticSearch(q, opts),
    });

    const results = await memory.recall('notes', {
      query: 'unpaid invoice billing question',
      minSimilarity: 0.5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('semantic');
    expect(String((results[0].value as { content: string }).content)).toContain(
      'invoice',
    );
  });
});
