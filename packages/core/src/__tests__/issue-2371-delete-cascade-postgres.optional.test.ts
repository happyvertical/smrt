/**
 * PostgreSQL proof of the delete cascade (#2371).
 *
 * Runs only in the dedicated disposable PostgreSQL shard. Three things the
 * SQLite suite cannot prove:
 *
 * - `@foreignKey` / `@crossPackageRef` columns are native `uuid` on PostgreSQL
 *   (text on SQLite). Every predicate the cascade builds — `col = $1`,
 *   `col IN ($1,…)` and the `SET NULL` update — is therefore bound against a
 *   real `uuid` column, where a wrong bind raises `22P02` instead of quietly
 *   matching nothing.
 * - The transaction is a real `BEGIN`/`ROLLBACK` on a pooled connection rather
 *   than SQLite's per-handle statement chain, so an aborted cascade proves
 *   atomicity on the engine deployments actually run on.
 * - `SET NULL` writes an actual SQL NULL into a `uuid` column; SQLite's type
 *   affinity would accept an empty string and hide the difference.
 *
 * Everything goes through the real model layer against a real database.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators/index';
import { DatabaseError } from '../errors';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const DOCS_TABLE = 'pg_2371_docs';
const TAGS_TABLE = 'pg_2371_doc_tags';
const BOOKMARKS_TABLE = 'pg_2371_bookmarks';
const LOCKS_TABLE = 'pg_2371_locks';
const ATTACHMENTS_TABLE = 'pg_2371_attachments';

@smrt({ tableName: 'pg_2371_docs' })
class PgCascadeDoc extends SmrtObject {
  title = '';
}

@smrt()
class PgCascadeDocCollection extends SmrtCollection<PgCascadeDoc> {
  static readonly _itemClass = PgCascadeDoc;
}

/** Junction row: `doc_id` is part of the natural key → default CASCADE. */
@smrt({ tableName: 'pg_2371_doc_tags', conflictColumns: ['doc_id', 'tag'] })
class PgCascadeDocTag extends SmrtObject {
  @foreignKey('PgCascadeDoc', { required: true })
  docId = '';

  @field({ required: true })
  tag = '';
}

@smrt()
class PgCascadeDocTagCollection extends SmrtCollection<PgCascadeDocTag> {
  static readonly _itemClass = PgCascadeDocTag;
}

@smrt({ tableName: 'pg_2371_bookmarks' })
class PgCascadeBookmark extends SmrtObject {
  @foreignKey('PgCascadeDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;
}

@smrt()
class PgCascadeBookmarkCollection extends SmrtCollection<PgCascadeBookmark> {
  static readonly _itemClass = PgCascadeBookmark;
}

@smrt({ tableName: 'pg_2371_locks' })
class PgCascadeLock extends SmrtObject {
  @foreignKey('PgCascadeDoc', { onDelete: 'RESTRICT', nullable: true })
  docId: string | null = null;
}

@smrt()
class PgCascadeLockCollection extends SmrtCollection<PgCascadeLock> {
  static readonly _itemClass = PgCascadeLock;
}

@smrt({
  tableName: 'pg_2371_attachments',
  conflictColumns: ['owner_key', 'meta_type', 'meta_id', 'role'],
})
class PgCascadeAttachment extends SmrtPolymorphicAssociation {
  @field({ required: true })
  ownerKey = '';
}

@smrt()
class PgCascadeAttachmentCollection extends SmrtCollection<PgCascadeAttachment> {
  static readonly _itemClass = PgCascadeAttachment;
}

const ALL_TABLES = [
  TAGS_TABLE,
  BOOKMARKS_TABLE,
  LOCKS_TABLE,
  ATTACHMENTS_TABLE,
  DOCS_TABLE,
];

describe.skipIf(!pgUrl)('delete() cascade on PostgreSQL (#2371)', () => {
  let db: DatabaseInterface;
  let docs: PgCascadeDocCollection;

  async function createTable(ctor: typeof SmrtObject): Promise<void> {
    const registration = ObjectRegistry.getClassByConstructor(ctor);
    const className =
      registration?.qualifiedName || registration?.name || ctor.name;
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
    await db.query(ddl);
  }

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2371-${randomUUID()}`,
      max: 4,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    for (const table of ALL_TABLES) {
      await db.query(`DROP TABLE IF EXISTS "${table}"`);
    }

    await createTable(PgCascadeDoc as unknown as typeof SmrtObject);
    await createTable(PgCascadeDocTag as unknown as typeof SmrtObject);
    await createTable(PgCascadeBookmark as unknown as typeof SmrtObject);
    await createTable(PgCascadeLock as unknown as typeof SmrtObject);
    await createTable(PgCascadeAttachment as unknown as typeof SmrtObject);

    // Every conflict target needs a matching unique index or the upsert
    // `save()` issues fails with 42P10 long before the cascade is reached. The
    // manifest schema path not emitting them is epic #2382's finding A4
    // (#2359/#2360), out of scope here.
    for (const table of [DOCS_TABLE, BOOKMARKS_TABLE, LOCKS_TABLE]) {
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_natural_uq" ` +
          `ON "${table}" (slug, context)`,
      );
    }
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TAGS_TABLE}_natural_uq" ` +
        `ON "${TAGS_TABLE}" (doc_id, tag)`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${ATTACHMENTS_TABLE}_natural_uq" ` +
        `ON "${ATTACHMENTS_TABLE}" (owner_key, meta_type, meta_id, role)`,
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      for (const table of ALL_TABLES) {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      }
    } finally {
      await db.close?.();
      ObjectRegistry.clear();
    }
  });

  beforeEach(async () => {
    for (const table of ALL_TABLES) {
      await db.query(`TRUNCATE "${table}"`);
    }
    docs = await PgCascadeDocCollection.create({ db });
  });

  async function makeDoc(title: string): Promise<PgCascadeDoc> {
    const doc = await docs.create({ title } as never);
    await doc.save();
    return doc;
  }

  it('deletes junction rows through a native uuid predicate', async () => {
    const tags = await PgCascadeDocTagCollection.create({ db });
    const doc = await makeDoc('cascaded');
    const other = await makeDoc('survivor');

    await tags.create({ docId: doc.id, tag: 'alpha' } as never);
    await tags.create({ docId: doc.id, tag: 'beta' } as never);
    await tags.create({ docId: other.id, tag: 'alpha' } as never);

    await doc.delete();

    const rows = await db.list(TAGS_TABLE, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doc_id).toBe(other.id);
  });

  it('writes a real SQL NULL into the uuid column for SET NULL', async () => {
    const bookmarks = await PgCascadeBookmarkCollection.create({ db });
    const doc = await makeDoc('bookmarked');
    await bookmarks.create({ docId: doc.id } as never);

    await doc.delete();

    const rows = await db.query(
      `SELECT doc_id, doc_id IS NULL AS is_null FROM "${BOOKMARKS_TABLE}"`,
    );
    const list = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: unknown[] }).rows ?? []);
    expect(list).toHaveLength(1);
    expect((list[0] as { is_null: boolean }).is_null).toBe(true);
  });

  it('rolls the whole cascade back when RESTRICT aborts the transaction', async () => {
    const tags = await PgCascadeDocTagCollection.create({ db });
    const locks = await PgCascadeLockCollection.create({ db });
    const doc = await makeDoc('guarded');

    await tags.create({ docId: doc.id, tag: 'alpha' } as never);
    await locks.create({ docId: doc.id } as never);

    await expect(doc.delete()).rejects.toThrow(DatabaseError);

    // Without a real transaction the junction row would already be gone: the
    // cascade visits the junction before it reaches the guarded reference.
    expect(await db.count(TAGS_TABLE)).toBe(1);
    expect(await db.count(DOCS_TABLE, { id: doc.id })).toBe(1);

    // The connection is usable afterwards — an aborted transaction was rolled
    // back, not left open in the `25P02` state.
    await expect(makeDoc('after-abort')).resolves.toBeDefined();
  });

  it('removes polymorphic association rows that name this class', async () => {
    const attachments = await PgCascadeAttachmentCollection.create({ db });
    const doc = await makeDoc('attached');
    const other = await makeDoc('untouched');

    await attachments.create({
      ownerKey: 'owner-1',
      metaType: 'PgCascadeDoc',
      metaId: doc.id,
      role: 'hero',
    } as never);
    await attachments.create({
      ownerKey: 'owner-1',
      metaType: 'PgCascadeDoc',
      metaId: other.id,
      role: 'hero',
    } as never);

    await doc.delete();

    const rows = await db.list(ATTACHMENTS_TABLE, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta_id).toBe(other.id);
  });

  it('clears the framework side tables owned by the deleted object', async () => {
    const doc = await makeDoc('remembers');
    await doc.remember({ scope: 'pg', key: 'k', value: 'v' });

    expect(await db.count('_smrt_contexts', { owner_id: doc.id })).toBe(1);

    await doc.delete();

    expect(await db.count('_smrt_contexts', { owner_id: doc.id })).toBe(0);
  });
});
