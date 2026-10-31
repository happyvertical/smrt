/**
 * Legacy cascade deletes under a caller-owned native DuckDB transaction (#2824).
 *
 * DuckDB has no SAVEPOINT, so the transaction-scoped handle the SDK passes to a
 * `db.transaction()` callback refuses a nested `transaction()` with
 * `NestedTransactionError`. `runCascadeDelete()` always opened one, so
 * `object.withDatabase(tx, () => object.delete())` was refused outright —
 * and with it every legacy `setLinks()` replacement, which loops `delete()`.
 *
 * The contract proven here, against real native DuckDB through the real model
 * layer: the cascade joins the caller's transaction (the only atomic scope
 * there is); the caller's commit persists it and the caller's rollback
 * discards it, including the framework-owned memory rows; and a cascade that
 * fails part-way aborts the caller's transaction so a swallowed error can never
 * commit half of it, without the delete being replayed.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CASCADE_ABORTED_CALLER_TRANSACTION } from '../cascade';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field } from '../decorators/index';
import { SmrtJunction } from '../junction';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_2824_docs' })
class Issue2824Doc extends SmrtObject {
  @field()
  title = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class Issue2824DocCollection extends SmrtCollection<Issue2824Doc> {
  static readonly _itemClass = Issue2824Doc;
}

/**
 * Natural-key child: CASCADE by default, so the plan is never empty. A
 * runtime-only reference, because DuckDB's DDL refuses a physical
 * `ON DELETE CASCADE` constraint; the application cascade is the rail here.
 */
@smrt({
  tableName: 'issue_2824_doc_tags',
  conflictColumns: ['doc_id', 'tag'],
})
class Issue2824DocTag extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:Issue2824Doc', { required: true })
  docId = '';

  @field({ required: true })
  tag = '';

  constructor(options: any = {}) {
    super(options);
    if (options.docId !== undefined) this.docId = options.docId;
    if (options.tag !== undefined) this.tag = options.tag;
  }
}

@smrt()
class Issue2824DocTagCollection extends SmrtCollection<Issue2824DocTag> {
  static readonly _itemClass = Issue2824DocTag;
}

@smrt({
  tableName: 'issue_2824_links',
  conflictColumns: ['owner_id', 'asset_id'],
})
class Issue2824Link extends SmrtObject {
  @field({ required: true })
  ownerId = '';

  @field({ required: true })
  assetId = '';

  @field()
  sortOrder = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.ownerId !== undefined) this.ownerId = options.ownerId;
    if (options.assetId !== undefined) this.assetId = options.assetId;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }
}

/**
 * A natural-key child of the link gives every link a cascade plan, which is
 * exactly what makes it batch-ineligible: `setLinks()` takes the legacy
 * per-row `delete()` path.
 */
@smrt({
  tableName: 'issue_2824_link_pins',
  conflictColumns: ['link_id'],
})
class Issue2824LinkPin extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:Issue2824Link', {
    required: true,
  })
  linkId = '';

  constructor(options: any = {}) {
    super(options);
    if (options.linkId !== undefined) this.linkId = options.linkId;
  }
}

@smrt()
class Issue2824LinkPinCollection extends SmrtCollection<Issue2824LinkPin> {
  static readonly _itemClass = Issue2824LinkPin;
}

@smrt()
class Issue2824LinkCollection extends SmrtJunction<Issue2824Link> {
  static readonly _itemClass = Issue2824Link;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
  protected positionField = 'sortOrder';
}

describe('caller-owned native DuckDB transaction delete (#2824)', () => {
  let db: DatabaseInterface;
  let docs: Issue2824DocCollection;
  let tags: Issue2824DocTagCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: [
        'Issue2824Doc',
        'Issue2824DocTag',
        'Issue2824Link',
        'Issue2824LinkPin',
      ],
    });
    docs = (await Issue2824DocCollection.create({
      db,
    })) as Issue2824DocCollection;
    tags = (await Issue2824DocTagCollection.create({
      db,
    })) as Issue2824DocTagCollection;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close?.();
  });

  /** A transaction the test (the caller), not the framework, owns. */
  function callerTransaction<T>(
    work: (tx: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    if (!db.transaction) throw new Error('DuckDB exposes transaction()');
    return db.transaction(work);
  }

  async function docWithTagsAndMemory(title: string): Promise<Issue2824Doc> {
    const doc = await docs.create({ title } as any);
    await doc.save();
    for (const tag of ['alpha', 'beta']) {
      await (await tags.create({ docId: doc.id, tag } as any)).save();
    }
    await doc.remember({ scope: 'test', key: 'k', value: 'owned' });
    return doc;
  }

  async function counts(id: string) {
    return {
      doc: await db.count('issue_2824_docs', { id }),
      tags: await db.count('issue_2824_doc_tags', { doc_id: id }),
      memory: await db.count('_smrt_contexts', { owner_id: id }),
    };
  }

  it('deletes the object, its cascade and its owned memory when the caller commits', async () => {
    const doc = await docWithTagsAndMemory('commit');
    const other = await docWithTagsAndMemory('survivor');
    expect(await counts(doc.id as string)).toEqual({
      doc: 1,
      tags: 2,
      memory: 1,
    });

    await callerTransaction(async (tx) => {
      await doc.withDatabase(tx, () => doc.delete());
    });

    expect(await counts(doc.id as string)).toEqual({
      doc: 0,
      tags: 0,
      memory: 0,
    });
    expect(await counts(other.id as string)).toEqual({
      doc: 1,
      tags: 2,
      memory: 1,
    });
    // The bound handle was restored and the object is now unpersisted.
    expect(doc.db).toBe(db);
  });

  it('restores everything when the caller rolls its transaction back', async () => {
    const doc = await docWithTagsAndMemory('rollback');

    await expect(
      callerTransaction(async (tx) => {
        await doc.withDatabase(tx, () => doc.delete());
        // Inside the caller's transaction the delete is visible...
        expect(await tx.count('issue_2824_docs', { id: doc.id })).toBe(0);
        throw new Error('caller aborts');
      }),
    ).rejects.toThrow('caller aborts');

    // ...and the caller's rollback discards it with the cascade and memory.
    expect(await counts(doc.id as string)).toEqual({
      doc: 1,
      tags: 2,
      memory: 1,
    });
  });

  it('works with a manual beginTransaction() handle', async () => {
    const doc = await docWithTagsAndMemory('manual');
    const begin = (
      db as unknown as {
        beginTransaction(): Promise<
          DatabaseInterface & {
            commit(): Promise<void>;
            rollback(): Promise<void>;
          }
        >;
      }
    ).beginTransaction;
    const tx = await begin.call(db);
    await doc.withDatabase(tx, () => doc.delete());
    await tx.rollback();
    expect((await counts(doc.id as string)).doc).toBe(1);

    const tx2 = await begin.call(db);
    await doc.withDatabase(tx2, () => doc.delete());
    await tx2.commit();
    expect(await counts(doc.id as string)).toEqual({
      doc: 0,
      tags: 0,
      memory: 0,
    });
  });

  it('aborts the caller transaction when the cascade fails part-way, without replaying it', async () => {
    const doc = await docWithTagsAndMemory('partial');
    let ownDeletes = 0;

    const outcome = await callerTransaction(async (tx) => {
      // The cascade removes the tags and the memory row first; the object's
      // own DELETE then fails, after part of the cascade already ran.
      const original = tx.delete.bind(tx);
      vi.spyOn(tx, 'delete').mockImplementation(async (table, where) => {
        if (table === 'issue_2824_docs') {
          ownDeletes += 1;
          throw new Error('own delete failed');
        }
        return original(table, where);
      });
      const error = await doc
        .withDatabase(tx, () => doc.delete())
        .catch((caught: unknown) => caught);
      // A caller that swallows the error and carries on cannot use the
      // transaction any more...
      const after = await tx
        .query('SELECT 1 AS one')
        .catch((caught: unknown) => caught);
      return { error, after };
    });

    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toContain('own delete failed');
    expect(outcome.after).toBeInstanceOf(Error);
    expect(String((outcome.after as Error).message)).toMatch(/aborted/i);
    expect(ownDeletes).toBe(1);
    // ...and its "commit" persisted none of the half-applied cascade.
    expect(await counts(doc.id as string)).toEqual({
      doc: 1,
      tags: 2,
      memory: 1,
    });
    expect(CASCADE_ABORTED_CALLER_TRANSACTION).toContain('aborted');
  });

  it('applies the same abort to a framework withTransaction() whose callback swallows the failure', async () => {
    const doc = await docWithTagsAndMemory('framework');
    await doc.withTransaction(async (bound) => {
      const tx = bound.db;
      const original = tx.delete.bind(tx);
      vi.spyOn(tx, 'delete').mockImplementation(async (table, where) => {
        if (table === 'issue_2824_docs') throw new Error('own delete failed');
        return original(table, where);
      });
      await expect(bound.delete()).rejects.toThrow('own delete failed');
    });
    // Before #2824 the framework transaction committed the half-applied
    // cascade (tags and memory gone, the object still present).
    expect(await counts(doc.id as string)).toEqual({
      doc: 1,
      tags: 2,
      memory: 1,
    });
  });

  describe('legacy junction replacement', () => {
    let links: Issue2824LinkCollection;
    let pins: Issue2824LinkPinCollection;

    beforeEach(async () => {
      links = (await Issue2824LinkCollection.create({
        db,
      })) as Issue2824LinkCollection;
      pins = (await Issue2824LinkPinCollection.create({
        db,
      })) as Issue2824LinkPinCollection;
      await links.setLinks('owner', ['a', 'b']);
      for (const link of await links.byLeft('owner')) {
        await (await pins.create({ linkId: link.id } as any)).save();
      }
    });

    async function assets(): Promise<string[]> {
      return (await db.list('issue_2824_links', { owner_id: 'owner' }))
        .map((row) => String(row.asset_id))
        .sort();
    }

    it('takes the legacy per-row path', async () => {
      const [first] = await links.byLeft('owner');
      expect(first?.supportsJunctionBatch()).toBe(false);
    });

    it('replaces the links inside a caller transaction that commits', async () => {
      await callerTransaction(async (tx) => {
        const bound = (await Issue2824LinkCollection.create({
          db: tx,
        })) as Issue2824LinkCollection;
        await bound.setLinks('owner', ['c']);
      });
      expect(await assets()).toEqual(['c']);
      expect(await db.count('issue_2824_link_pins')).toBe(0);
    });

    it('keeps the original links when the caller rolls back', async () => {
      await expect(
        callerTransaction(async (tx) => {
          const bound = (await Issue2824LinkCollection.create({
            db: tx,
          })) as Issue2824LinkCollection;
          await bound.setLinks('owner', ['c']);
          throw new Error('caller aborts');
        }),
      ).rejects.toThrow('caller aborts');
      expect(await assets()).toEqual(['a', 'b']);
      expect(await db.count('issue_2824_link_pins')).toBe(2);
    });
  });
});
