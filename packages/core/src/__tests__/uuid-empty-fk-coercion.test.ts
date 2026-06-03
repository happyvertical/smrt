/**
 * Regression test for the whole-PR review C1/M1 blocker.
 *
 * `@foreignKey()` / `@crossPackageRef()` fields generate native `UUID` columns
 * (R11). Their TypeScript default is the empty string (`''`), which is NOT a
 * valid UUID literal. On a native-uuid dialect (Postgres, DuckDB) inserting
 * `''` into a `uuid` column fails with `invalid input syntax for type uuid`.
 *
 * This bites every optional/unset declared-FK field — most importantly ROOT
 * entities whose optional self-reference is never set (e.g. a root Fact with no
 * predecessor: `previousFactId` stays `''`). The save path must coerce `''` →
 * `NULL` for UUID columns before the INSERT/UPDATE.
 *
 * The fix lives in `SmrtObject.coerceEmptyUuidValuesToNull()` (object.ts),
 * called from `save()`.
 *
 * Two layers of coverage:
 *  1. Save path on real in-memory SQLite (the mandated test DB): a root entity
 *     with an unset optional uuid FK must persist the column as SQL NULL, not
 *     `''`. Fails-before (value is `''`), passes-after (value is NULL). SQLite
 *     maps UUID→TEXT, so this isolates the *coercion* independent of dialect.
 *  2. Native-uuid dialect proof on DuckDB: binding `''` into a real `uuid`
 *     column throws; `NULL` succeeds. This documents the exact failure the
 *     coercion prevents on Postgres/DuckDB.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { foreignKey, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';
import { getTestDatabase } from '../testing/database';

// A class with a self-referential optional FK that defaults to '' — the exact
// shape of facts/src/fact.ts `previousFactId`. Declared FKs become native UUID
// columns under R11.
@smrt()
class RootableNode extends SmrtObject {
  name: string = '';

  @foreignKey('RootableNode')
  predecessorId: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.predecessorId) this.predecessorId = options.predecessorId;
  }
}

class RootableNodeCollection extends SmrtCollection<RootableNode> {
  static readonly _itemClass = RootableNode;
}

describe('UUID FK empty-string coercion (whole-PR review C1/M1)', () => {
  describe('save path coerces "" → NULL for the uuid FK column', () => {
    let db: Awaited<ReturnType<typeof getTestDatabase>>;
    let collection: RootableNodeCollection;

    beforeEach(async () => {
      ObjectRegistry.registerCollection('RootableNode', RootableNodeCollection);
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      collection = await RootableNodeCollection.create({ db });
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

    it('persists NULL (not "") for an unset optional uuid FK on a ROOT entity', async () => {
      const root = await collection.create({
        slug: 'root-node',
        name: 'Root',
        // predecessorId intentionally left at its '' default
      });
      await root.save();

      // Read the raw column value: before the fix this is the empty string,
      // which on a native-uuid dialect would have thrown on INSERT.
      const result = await db.query(
        'SELECT predecessor_id FROM rootable_nodes WHERE slug = ?',
        ['root-node'],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].predecessor_id).toBeNull();
    });

    it('still persists a real uuid FK when predecessorId is set', async () => {
      const parent = await collection.create({
        slug: 'parent-node',
        name: 'Parent',
      });
      await parent.save();

      const child = await collection.create({
        slug: 'child-node',
        name: 'Child',
        predecessorId: parent.id,
      });
      await child.save();

      const result = await db.query(
        'SELECT predecessor_id FROM rootable_nodes WHERE slug = ?',
        ['child-node'],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].predecessor_id).toBe(parent.id);
    });
  });

  describe('native-uuid dialect (DuckDB) failure mode the coercion prevents', () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;

    beforeEach(async () => {
      db = await getDatabase({ type: 'duckdb', url: ':memory:' });
      await db.query(
        'CREATE TABLE uuid_probe (id UUID PRIMARY KEY, ref UUID)',
        [],
      );
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

    it('rejects "" but accepts NULL for a native uuid column', async () => {
      const id1 = randomUUID();
      // Empty string into a native uuid column is the failure the coercion fixes.
      await expect(
        db.query('INSERT INTO uuid_probe (id, ref) VALUES (?, ?)', [id1, '']),
      ).rejects.toThrow();

      // NULL (what the coercion produces) inserts cleanly.
      const id2 = randomUUID();
      await expect(
        db.query('INSERT INTO uuid_probe (id, ref) VALUES (?, ?)', [id2, null]),
      ).resolves.toBeDefined();

      const result = await db.query('SELECT ref FROM uuid_probe WHERE id = ?', [
        id2,
      ]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].ref).toBeNull();
    });
  });
});
