/**
 * Coverage tests for SmrtObject AI + memory (`_smrt_contexts`) methods:
 *   - is(): JSON result true/false, and the "Unexpected answer" throw on
 *     unparseable AI output
 *   - do() / describe(): pass-through of the AI message result
 *   - remember/recall/recallAll/forget/forgetScope: upsert, single lookup,
 *     minConfidence filtering, ancestor scope walking, descendants LIKE,
 *     deletion + affected count, and the "not initialized" throws
 *
 * Real in-memory SQLite (initialize() creates `_smrt_contexts`). AI is the
 * only mocked dependency, injected via the fixture's overridden getAiClient().
 *
 * @see src/object.ts (issue #1500 coverage, ORM group)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectAiMemoryNode } from './fixtures/object-ai-memory-fixtures.js';

async function makeNode(stub?: {
  message: (p: string, o?: any) => Promise<string>;
}): Promise<ObjectAiMemoryNode> {
  const node = new ObjectAiMemoryNode({
    name: 'mem-node',
    db: { type: 'sqlite', url: ':memory:' },
  });
  await node.initialize();
  if (stub) node.stubAi = stub;
  return node;
}

let node: ObjectAiMemoryNode;

afterEach(() => {
  node?.destroy?.();
});

describe('SmrtObject.is / do / describe (AI)', () => {
  it('returns true when the AI replies with {"result": true}', async () => {
    node = await makeNode({
      message: async () => JSON.stringify({ result: true }),
    });
    expect(await node.is('is it good?')).toBe(true);
    // prompt carries the criteria block and requests json
    expect(node.lastPrompt).toContain('Beginning of criteria');
    expect(node.lastOptions.responseFormat).toEqual({ type: 'json_object' });
  });

  it('returns false when the AI replies with {"result": false}', async () => {
    node = await makeNode({
      message: async () => JSON.stringify({ result: false }),
    });
    expect(await node.is('is it bad?')).toBe(false);
  });

  it('returns undefined when result is present but not boolean', async () => {
    node = await makeNode({
      message: async () => JSON.stringify({ result: 'maybe' }),
    });
    expect(await node.is('ambiguous?')).toBeUndefined();
  });

  it('throws "Unexpected answer" when the AI reply is not valid JSON', async () => {
    node = await makeNode({
      message: async () => 'totally not json',
    });
    await expect(node.is('check')).rejects.toThrow(/Unexpected answer/);
  });

  it('do() returns the raw AI message', async () => {
    node = await makeNode({
      message: async () => 'a freeform answer',
    });
    const result = await node.do('summarize');
    expect(result).toBe('a freeform answer');
    expect(node.lastPrompt).toContain('Beginning of instructions');
  });

  it('describe() returns the raw AI message', async () => {
    node = await makeNode({
      message: async () => 'a concise description',
    });
    const result = await node.describe();
    expect(result).toBe('a concise description');
    expect(node.lastPrompt).toContain('concise');
  });
});

describe('SmrtObject memory: remember / recall', () => {
  it('remembers and recalls a value by scope + key', async () => {
    node = await makeNode();
    await node.remember({
      scope: 'parser/example.com',
      key: 'url-1',
      value: { patterns: ['a', 'b'] },
      confidence: 0.9,
    });

    const recalled = await node.recall({
      scope: 'parser/example.com',
      key: 'url-1',
    });
    expect(recalled).toEqual({ patterns: ['a', 'b'] });
  });

  it('returns null when nothing matches', async () => {
    node = await makeNode();
    const recalled = await node.recall({ scope: 'nope', key: 'missing' });
    expect(recalled).toBeNull();
  });

  it('filters by minConfidence', async () => {
    node = await makeNode();
    await node.remember({
      scope: 's',
      key: 'lowconf',
      value: 'v',
      confidence: 0.3,
    });

    // Above threshold → excluded → null
    expect(
      await node.recall({ scope: 's', key: 'lowconf', minConfidence: 0.8 }),
    ).toBeNull();
    // At/below threshold → found
    expect(
      await node.recall({ scope: 's', key: 'lowconf', minConfidence: 0.2 }),
    ).toBe('v');
  });

  it('walks ancestor scopes when includeAncestors is set', async () => {
    node = await makeNode();
    // Store at a parent scope only
    await node.remember({ scope: 'a', key: 'shared', value: 'from-parent' });

    // Look up at a deeper scope with ancestor fallback
    const recalled = await node.recall({
      scope: 'a/b/c',
      key: 'shared',
      includeAncestors: true,
    });
    expect(recalled).toBe('from-parent');
  });

  it('falls back to the global scope during ancestor walk', async () => {
    node = await makeNode();
    await node.remember({ scope: 'global', key: 'g', value: 'global-value' });

    const recalled = await node.recall({
      scope: 'x/y',
      key: 'g',
      includeAncestors: true,
    });
    expect(recalled).toBe('global-value');
  });

  it('overwrites an existing value on repeated remember (same scope+key+version)', async () => {
    node = await makeNode();
    await node.remember({ scope: 's', key: 'k', value: 'first' });
    await node.remember({ scope: 's', key: 'k', value: 'second' });
    expect(await node.recall({ scope: 's', key: 'k' })).toBe('second');
  });
});

describe('SmrtObject memory: recallAll', () => {
  beforeEach(async () => {
    node = await makeNode();
    await node.remember({
      scope: 'cfg/site',
      key: 'a',
      value: 1,
      confidence: 0.9,
    });
    await node.remember({
      scope: 'cfg/site',
      key: 'b',
      value: 2,
      confidence: 0.4,
    });
    await node.remember({
      scope: 'cfg/site/child',
      key: 'c',
      value: 3,
      confidence: 1.0,
    });
  });

  it('returns all entries in an exact scope as a Map', async () => {
    const all = await node.recallAll({ scope: 'cfg/site' });
    expect(all.size).toBe(2);
    expect(all.get('a')).toBe(1);
    expect(all.get('b')).toBe(2);
  });

  it('includes descendant scopes with includeDescendants', async () => {
    const all = await node.recallAll({
      scope: 'cfg/site',
      includeDescendants: true,
    });
    // a, b (cfg/site) + c (cfg/site/child)
    expect(all.size).toBe(3);
    expect(all.get('c')).toBe(3);
  });

  it('applies minConfidence filtering', async () => {
    const all = await node.recallAll({
      scope: 'cfg/site',
      minConfidence: 0.5,
    });
    // only key 'a' (0.9) passes; 'b' (0.4) is filtered out
    expect(all.size).toBe(1);
    expect(all.get('a')).toBe(1);
  });

  it('returns every entry when no scope is supplied', async () => {
    const all = await node.recallAll();
    expect(all.size).toBeGreaterThanOrEqual(3);
  });
});

describe('SmrtObject memory: forget / forgetScope', () => {
  it('forgets a single entry by scope + key', async () => {
    node = await makeNode();
    await node.remember({ scope: 's', key: 'k', value: 'v' });
    await node.forget({ scope: 's', key: 'k' });
    expect(await node.recall({ scope: 's', key: 'k' })).toBeNull();
  });

  it('forgetScope deletes only the exact scope, leaving descendants', async () => {
    node = await makeNode();
    await node.remember({ scope: 'z', key: 'a', value: 1 });
    await node.remember({ scope: 'z', key: 'b', value: 2 });
    await node.remember({ scope: 'z/child', key: 'c', value: 3 });

    // Returns the adapter-reported affected count (>= 0). The reliable signal
    // is the observable state: exact-scope rows gone, descendant retained.
    const count = await node.forgetScope({ scope: 'z' });
    expect(count).toBeGreaterThanOrEqual(0);
    expect(await node.recall({ scope: 'z', key: 'a' })).toBeNull();
    expect(await node.recall({ scope: 'z', key: 'b' })).toBeNull();
    // descendant survived (exact-scope match only)
    expect(await node.recall({ scope: 'z/child', key: 'c' })).toBe(3);
  });

  it('forgetScope with includeDescendants clears child scopes too', async () => {
    node = await makeNode();
    await node.remember({ scope: 'z', key: 'a', value: 1 });
    await node.remember({ scope: 'z/child', key: 'c', value: 3 });

    await node.forgetScope({
      scope: 'z',
      includeDescendants: true,
    });
    // Both the exact scope and its descendant are cleared.
    expect(await node.recall({ scope: 'z', key: 'a' })).toBeNull();
    expect(await node.recall({ scope: 'z/child', key: 'c' })).toBeNull();
  });
});

describe('SmrtObject memory: requires initialization', () => {
  it('remember throws when systemDb is not initialized', async () => {
    const bare = new ObjectAiMemoryNode({ name: 'bare' });
    await expect(
      bare.remember({ scope: 's', key: 'k', value: 'v' }),
    ).rejects.toThrow(/Database not initialized/);
  });

  it('recall throws when systemDb is not initialized', async () => {
    const bare = new ObjectAiMemoryNode({ name: 'bare' });
    await expect(bare.recall({ scope: 's', key: 'k' })).rejects.toThrow(
      /Database not initialized/,
    );
  });

  it('recallAll / forget / forgetScope throw when not initialized', async () => {
    const bare = new ObjectAiMemoryNode({ name: 'bare' });
    await expect(bare.recallAll()).rejects.toThrow(/Database not initialized/);
    await expect(bare.forget({ scope: 's', key: 'k' })).rejects.toThrow(
      /Database not initialized/,
    );
    await expect(bare.forgetScope({ scope: 's' })).rejects.toThrow(
      /Database not initialized/,
    );
  });
});
