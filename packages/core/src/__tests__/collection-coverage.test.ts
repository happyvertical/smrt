/**
 * Coverage tests for SmrtCollection convenience + reporting methods:
 *   - findById / findOne / findAll (delegators) and listByIds (incl. the
 *     empty-array short-circuit)
 *   - count(): no filter, with a where filter
 *   - getDiff(): changed-subset diff, and null when nothing changed
 *   - getOrUpsert(): create path, update-by-slug path, no-op-when-unchanged path
 *   - collection-scoped memory: remember/recall/recallAll/forget/forgetScope and
 *     the "not initialized" throws
 *
 * Real in-memory SQLite via getTestDatabase(); no mocking.
 *
 * @see src/collection.ts (issue #1500 coverage, ORM group)
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDatabase } from '../testing/database';
import {
  CovWidget,
  CovWidgetCollection,
} from './fixtures/collection-coverage-fixtures.js';

let db: DatabaseInterface;
let widgets: CovWidgetCollection;

beforeEach(async () => {
  db = await getTestDatabase({ classes: ['CovWidget'], url: ':memory:' });
  widgets = await CovWidgetCollection.create({ db });
});

afterEach(async () => {
  if (db && typeof db.close === 'function') {
    try {
      await db.close();
    } catch {
      // ignore
    }
  }
});

describe('SmrtCollection convenience finders', () => {
  it('findById delegates to get() and returns the row or null', async () => {
    const created = await widgets.create({ name: 'Alpha', price: 1.5 });
    const found = await widgets.findById(created.id as string);
    expect(found?.name).toBe('Alpha');

    const missing = await widgets.findById('does-not-exist');
    expect(missing).toBeNull();
  });

  it('findOne delegates to get() with a where clause', async () => {
    await widgets.create({ name: 'Beta', category: 'tools' });
    const found = await widgets.findOne({ where: { name: 'Beta' } });
    expect(found?.category).toBe('tools');
  });

  it('findAll delegates to list() with options', async () => {
    await widgets.create({ name: 'A', category: 'x' });
    await widgets.create({ name: 'B', category: 'x' });
    await widgets.create({ name: 'C', category: 'y' });

    const xs = await widgets.findAll({ where: { category: 'x' } });
    expect(xs).toHaveLength(2);
  });

  it('listByIds returns [] for an empty id list (no query)', async () => {
    const result = await widgets.listByIds([]);
    expect(result).toEqual([]);
  });

  it('listByIds fetches multiple rows by id', async () => {
    const a = await widgets.create({ name: 'one' });
    const b = await widgets.create({ name: 'two' });
    const c = await widgets.create({ name: 'three' });

    const some = await widgets.listByIds([a.id as string, c.id as string]);
    expect(some.map((w) => w.name).sort()).toEqual(['one', 'three']);
    // 'two' (b) intentionally excluded
    expect(some.find((w) => w.id === b.id)).toBeUndefined();
  });
});

describe('SmrtCollection.count', () => {
  it('counts all rows when no filter is supplied', async () => {
    await widgets.create({ name: 'a' });
    await widgets.create({ name: 'b' });
    expect(await widgets.count()).toBe(2);
  });

  it('counts rows matching a where filter', async () => {
    await widgets.create({ name: 'a', category: 'keep' });
    await widgets.create({ name: 'b', category: 'keep' });
    await widgets.create({ name: 'c', category: 'drop' });
    expect(await widgets.count({ where: { category: 'keep' } })).toBe(2);
  });
});

describe('SmrtCollection.getDiff', () => {
  it('returns only the changed fields', async () => {
    const existing = { name: 'old', price: 1, category: 'x' };
    const diff = await widgets.getDiff(existing, { name: 'new', price: 1 });
    expect(diff).toEqual({ name: 'new' });
  });

  it('returns null when nothing changed', async () => {
    const existing = { name: 'same', price: 5 };
    const diff = await widgets.getDiff(existing, { name: 'same', price: 5 });
    expect(diff).toBeNull();
  });

  it('ignores keys that are not valid fields', async () => {
    const existing = { name: 'n' };
    const diff = await widgets.getDiff(existing, {
      bogusField: 'whatever',
    });
    expect(diff).toBeNull();
  });
});

describe('SmrtCollection.getOrUpsert', () => {
  it('creates a new row when none matches', async () => {
    const created = await widgets.getOrUpsert(
      { slug: 'gadget-1' },
      { name: 'Gadget One', price: 9.99 },
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Gadget One');
    expect(await widgets.count()).toBe(1);
  });

  it('updates an existing row identified by slug', async () => {
    await widgets.getOrUpsert({ slug: 'gadget-2' }, { name: 'First' });
    const updated = await widgets.getOrUpsert({
      slug: 'gadget-2',
      name: 'Second',
    });
    expect(updated.name).toBe('Second');
    // Still a single row — upsert, not insert
    expect(await widgets.count()).toBe(1);
  });

  it('returns the existing row unchanged when the diff is empty', async () => {
    const first = await widgets.getOrUpsert(
      { slug: 'gadget-3' },
      { name: 'Stable' },
    );
    const again = await widgets.getOrUpsert({
      slug: 'gadget-3',
      name: 'Stable',
    });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('Stable');
  });
});

describe('SmrtCollection memory (collection-scoped)', () => {
  it('remembers and recalls a collection-scoped value', async () => {
    await widgets.remember({
      scope: 'crawl/site',
      key: 'k1',
      value: { seen: true },
      confidence: 0.8,
    });
    const recalled = await widgets.recall({ scope: 'crawl/site', key: 'k1' });
    expect(recalled).toEqual({ seen: true });
  });

  it('recall returns null when no entry matches', async () => {
    expect(await widgets.recall({ scope: 'none', key: 'x' })).toBeNull();
  });

  it('recallAll returns a Map of entries in a scope', async () => {
    await widgets.remember({ scope: 's', key: 'a', value: 1 });
    await widgets.remember({ scope: 's', key: 'b', value: 2 });
    const all = await widgets.recallAll({ scope: 's' });
    expect(all.size).toBe(2);
    expect(all.get('a')).toBe(1);
  });

  it('forget removes a single entry', async () => {
    await widgets.remember({ scope: 's', key: 'gone', value: 1 });
    await widgets.forget({ scope: 's', key: 'gone' });
    expect(await widgets.recall({ scope: 's', key: 'gone' })).toBeNull();
  });

  it('forgetScope clears entries in a scope', async () => {
    await widgets.remember({ scope: 'wipe', key: 'a', value: 1 });
    await widgets.remember({ scope: 'wipe', key: 'b', value: 2 });
    await widgets.forgetScope({ scope: 'wipe' });
    expect(await widgets.recall({ scope: 'wipe', key: 'a' })).toBeNull();
    expect(await widgets.recall({ scope: 'wipe', key: 'b' })).toBeNull();
  });

  // #1378: a corrupted _smrt_contexts.value must not throw out of recall paths.
  it('recall() skips a corrupted value (treats it as a miss)', async () => {
    await widgets.remember({ scope: 'corrupt', key: 'bad', value: { ok: 1 } });
    // Corrupt the stored JSON directly (systemDb === the test db).
    await db.query(
      `UPDATE _smrt_contexts SET value = $1 WHERE scope = $2 AND key = $3`,
      '{not valid json',
      'corrupt',
      'bad',
    );

    let recalled: unknown;
    await expect(
      (async () => {
        recalled = await widgets.recall({ scope: 'corrupt', key: 'bad' });
      })(),
    ).resolves.toBeUndefined();
    expect(recalled).toBeNull();
  });

  it('recallAll() skips a corrupted row and returns the rest', async () => {
    await widgets.remember({ scope: 'mix', key: 'good', value: 42 });
    await widgets.remember({ scope: 'mix', key: 'bad', value: { ok: 1 } });
    await db.query(
      `UPDATE _smrt_contexts SET value = $1 WHERE scope = $2 AND key = $3`,
      '<<<corrupt>>>',
      'mix',
      'bad',
    );

    const all = await widgets.recallAll({ scope: 'mix' });
    expect(all.get('good')).toBe(42);
    expect(all.has('bad')).toBe(false);
  });
});

describe('SmrtCollection memory requires initialization', () => {
  it('throws from memory methods when systemDb is not initialized', async () => {
    const bare = new CovWidgetCollection({});
    await expect(
      bare.remember({ scope: 's', key: 'k', value: 'v' }),
    ).rejects.toThrow(/Database not initialized/);
    await expect(bare.recall({ scope: 's', key: 'k' })).rejects.toThrow(
      /Database not initialized/,
    );
    await expect(bare.recallAll()).rejects.toThrow(/Database not initialized/);
    await expect(bare.forget({ scope: 's', key: 'k' })).rejects.toThrow(
      /Database not initialized/,
    );
    await expect(bare.forgetScope({ scope: 's' })).rejects.toThrow(
      /Database not initialized/,
    );
    // Reference the item class so the import is load-bearing.
    expect(CovWidget.name).toBe('CovWidget');
  });
});
