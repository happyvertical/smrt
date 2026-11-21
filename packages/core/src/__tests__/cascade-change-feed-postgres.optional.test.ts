/**
 * PostgreSQL proof that a delete cascade sees every referencing row (#5444).
 *
 * Under READ COMMITTED another connection could add a reference to a row the
 * cascade is about to delete after the cascade scanned for references; the
 * database's own ON DELETE action would then remove or null that row without
 * the cascade returning it, and the change feed would miss it. The cascade
 * locks each level's rows FOR UPDATE before scanning, so a concurrent new
 * reference waits for the cascade's transaction. PGlite is one session and
 * cannot show this; it runs in the disposable PostgreSQL shard (`pg-lane`).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cascadeReferencesTo } from '../cascade';
import { foreignKey } from '../decorators/index';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const DOCS = 'pg_cascade_feed_docs';
const CHILDREN = 'pg_cascade_feed_children';

@smrt({ tableName: 'pg_cascade_feed_docs' })
class PgCascadeFeedDoc extends SmrtObject {
  title: string = '';
}

@smrt({ tableName: 'pg_cascade_feed_children' })
class PgCascadeFeedChild extends SmrtObject {
  @foreignKey('PgCascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
}

function qualified(ctor: typeof SmrtObject): string {
  const registration = ObjectRegistry.getClassByConstructor(ctor);
  return registration?.qualifiedName || registration?.name || ctor.name;
}

describe.skipIf(!pgUrl)('delete cascade locks referenced rows (#5444)', () => {
  let db: DatabaseInterface;
  let other: DatabaseInterface;

  beforeAll(async () => {
    db = (await getTestDatabase({
      type: 'postgres',
      url: pgUrl,
      classes: [],
    })) as DatabaseInterface;
    other = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-5444-${randomUUID()}`,
      max: 2,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await db.query(`DROP TABLE IF EXISTS "${CHILDREN}"`);
    await db.query(`DROP TABLE IF EXISTS "${DOCS}"`);
    for (const ctor of [PgCascadeFeedDoc, PgCascadeFeedChild]) {
      const ddl = ObjectRegistry.getSchemaDDL(
        qualified(ctor as unknown as typeof SmrtObject),
        'postgres',
      );
      if (!ddl) throw new Error(`Missing schema DDL for ${ctor.name}`);
      await db.query(ddl);
    }
    for (const table of [DOCS, CHILDREN]) {
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_natural_uq" ON "${table}" (slug, context)`,
      );
    }
    // The physical reference is what makes a concurrent insert or update
    // take FOR KEY SHARE on its target row.
    const existing = await db.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('${CHILDREN}') AND contype = 'f'`,
    );
    if (existing.rows.length === 0) {
      await db.query(
        `ALTER TABLE "${CHILDREN}" ADD FOREIGN KEY (doc_id)
           REFERENCES "${DOCS}" (id) ON DELETE CASCADE`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${CHILDREN}"`);
      await db?.query(`DROP TABLE IF EXISTS "${DOCS}"`);
    } finally {
      await other?.close?.();
      await db?.close?.();
    }
  });

  async function make<T extends SmrtObject>(
    Ctor: new (options: { db: DatabaseInterface }) => T,
    values: Record<string, unknown>,
  ): Promise<T> {
    const instance = await new Ctor({ db }).initialize();
    Object.assign(instance, values);
    await instance.save();
    return instance;
  }

  it('makes a new reference to a row being cascaded wait for the cascade', async () => {
    const doomed = await make(PgCascadeFeedDoc, { title: 'doomed' });
    const kept = await make(PgCascadeFeedDoc, { title: 'kept' });
    const child = await make(PgCascadeFeedChild, { docId: kept.id });

    const rollback = new Error('roll back');
    const transaction = (database: DatabaseInterface) => {
      if (!database.transaction) throw new Error('transactions required');
      return database.transaction.bind(database);
    };
    await expect(
      transaction(db)(async (tx) => {
        await cascadeReferencesTo(tx, ObjectRegistry, {
          className: qualified(
            PgCascadeFeedDoc as unknown as typeof SmrtObject,
          ),
          tableName: DOCS,
          ids: [doomed.id as string],
        });
        // Another connection re-points an existing child at the row the
        // cascade is deleting: it must wait (here: time out) instead of
        // slipping in after the cascade's scan.
        await expect(
          transaction(other)(async (concurrent) => {
            await concurrent.query("SET LOCAL lock_timeout = '300ms'");
            await concurrent.query(
              `UPDATE "${CHILDREN}" SET doc_id = $1 WHERE id = $2`,
              doomed.id,
              child.id,
            );
          }),
        ).rejects.toThrow(/lock|55P03/i);
        throw rollback;
      }),
    ).rejects.toThrow(rollback.message);

    const stored = await db.query(
      `SELECT CAST(doc_id AS VARCHAR) AS doc_id FROM "${CHILDREN}" WHERE id = $1`,
      child.id,
    );
    expect(stored.rows[0]?.doc_id).toBe(kept.id);
  });
});
