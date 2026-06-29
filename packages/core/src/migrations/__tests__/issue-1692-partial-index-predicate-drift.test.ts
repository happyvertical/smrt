/**
 * Tests for partial-index predicate drift detection (issue #1692).
 *
 * Before this fix the differ built each index signature from columns +
 * uniqueness only, dropping the partial-index `WHERE` predicate. Two indexes
 * on the same column(s) that differed solely by their predicate — e.g.
 * distinct STI child partial indexes — collapsed to one signature, so the
 * differ:
 *
 * - treated a same-name partial vs non-partial (or predicate-altered) index
 *   as unchanged, and
 * - let one partial index's signature "claim" another's, missing genuine
 *   adds/drops.
 *
 * The fix introspects each index's predicate from the live DB
 * (`sqlite_master.sql` for SQLite/DuckDB/JSON, `pg_indexes.indexdef` for
 * PostgreSQL) and folds the normalized predicate into the signature on BOTH
 * the manifest (desired) and DB (introspected) sides.
 *
 * Per `.claude/rules/testing.md`, these run against a real in-memory SQLite
 * database — DB operations are never mocked.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import {
  extractIndexPredicate,
  normalizeIndexPredicate,
  SchemaComparer,
} from '../differ.js';

function tableSchema(
  overrides: Partial<SchemaDefinition> = {},
): SchemaDefinition {
  return {
    tableName: 'tenants',
    ddl: 'CREATE TABLE tenants (id TEXT PRIMARY KEY, owner_id TEXT, _meta_type TEXT);',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      owner_id: { type: 'TEXT' },
      _meta_type: { type: 'TEXT' },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
    ...overrides,
  };
}

describe('SchemaComparer partial-index predicate drift (issue #1692)', () => {
  let db: DatabaseProvider;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      'CREATE TABLE tenants (id TEXT PRIMARY KEY, owner_id TEXT, _meta_type TEXT);',
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

  describe('signature collision (the headline bug)', () => {
    it('does not let two same-column partial indexes collide by signature', async () => {
      // DB has the ClassA partial index already; the manifest declares BOTH
      // the ClassA and ClassB partial indexes (same column, different
      // predicate). The ClassB index must be added — its predicate makes it a
      // distinct index, not a duplicate of ClassA.
      await db.query(
        "CREATE INDEX idx_tenants_owner_a ON tenants(owner_id) WHERE _meta_type = 'ClassA';",
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner_a',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassA'",
            },
            {
              name: 'idx_tenants_owner_b',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassB'",
            },
          ],
        }),
      });

      const adds = diff.changes.filter((c) => c.type === 'add_index');
      const addedNames = adds.map((c) => c.name);
      expect(addedNames).toContain('idx_tenants_owner_b');
      // The already-present ClassA partial index must NOT be re-added or
      // flagged as drifted.
      expect(addedNames).not.toContain('idx_tenants_owner_a');
      expect(diff.changes.filter((c) => c.type === 'drop_index')).toHaveLength(
        0,
      );
    });

    it('does not treat a different-name partial index as equivalent under a different predicate', async () => {
      // DB carries a stale ClassA partial index; the manifest wants a ClassB
      // partial index on the same column under a different name. They share
      // columns + uniqueness but NOT the predicate, so the manifest index is
      // genuinely missing and the DB index is a genuine orphan.
      await db.query(
        "CREATE INDEX renamed_owner_a ON tenants(owner_id) WHERE _meta_type = 'ClassA';",
      );

      const comparer = new SchemaComparer(db, { includeDroppedIndexes: true });
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner_b',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassB'",
            },
          ],
        }),
      });

      const added = diff.changes
        .filter((c) => c.type === 'add_index')
        .map((c) => c.name);
      const dropped = diff.changes
        .filter((c) => c.type === 'drop_index')
        .map((c) => c.name);

      expect(added).toContain('idx_tenants_owner_b');
      expect(dropped).toContain('renamed_owner_a');
    });
  });

  describe('same-name predicate drift', () => {
    it('detects adding a predicate (non-partial → partial)', async () => {
      await db.query('CREATE INDEX idx_tenants_owner ON tenants(owner_id);');

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassA'",
            },
          ],
        }),
      });

      const recreate = diff.changes
        .filter((c) => c.name === 'idx_tenants_owner')
        .map((c) => c.type);
      expect(recreate).toEqual(['drop_index', 'add_index']);
    });

    it('detects removing a predicate (partial → non-partial)', async () => {
      await db.query(
        "CREATE INDEX idx_tenants_owner ON tenants(owner_id) WHERE _meta_type = 'ClassA';",
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner',
              columns: ['owner_id'],
            },
          ],
        }),
      });

      const recreate = diff.changes
        .filter((c) => c.name === 'idx_tenants_owner')
        .map((c) => c.type);
      expect(recreate).toEqual(['drop_index', 'add_index']);
    });

    it('detects altering a predicate and recreates with the new WHERE clause', async () => {
      await db.query(
        "CREATE INDEX idx_tenants_owner ON tenants(owner_id) WHERE _meta_type = 'ClassA';",
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassB'",
            },
          ],
        }),
      });

      const changes = diff.changes.filter(
        (c) => c.name === 'idx_tenants_owner',
      );
      expect(changes.map((c) => c.type)).toEqual(['drop_index', 'add_index']);

      // The regenerated CREATE INDEX must carry the new predicate — otherwise
      // the "repair" silently widens the partial index into a full index.
      const add = changes.find((c) => c.type === 'add_index');
      expect(add?.sql).toContain("WHERE _meta_type = 'ClassB'");
    });
  });

  describe('no false drift on matching predicates', () => {
    it('does not flag an identical partial index as drifted', async () => {
      await db.query(
        "CREATE INDEX idx_tenants_owner ON tenants(owner_id) WHERE _meta_type = 'ClassA';",
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassA'",
            },
          ],
        }),
      });

      expect(
        diff.changes.filter(
          (c) => c.type === 'add_index' || c.type === 'drop_index',
        ),
      ).toHaveLength(0);
    });

    it('tolerates whitespace differences between the manifest and live predicate', async () => {
      // The live index was created with loose spacing; the manifest is tight.
      // They are semantically identical and must not produce drift.
      await db.query(
        "CREATE INDEX idx_tenants_owner ON tenants(owner_id) WHERE _meta_type   =    'ClassA';",
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner',
              columns: ['owner_id'],
              where: "_meta_type = 'ClassA'",
            },
          ],
        }),
      });

      expect(
        diff.changes.filter(
          (c) => c.type === 'add_index' || c.type === 'drop_index',
        ),
      ).toHaveLength(0);
    });

    it('does not regress non-partial same-shape indexes', async () => {
      await db.query(
        'CREATE UNIQUE INDEX idx_tenants_owner ON tenants(owner_id);',
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_owner',
              columns: ['owner_id'],
              unique: true,
            },
          ],
        }),
      });

      expect(
        diff.changes.filter(
          (c) => c.type === 'add_index' || c.type === 'drop_index',
        ),
      ).toHaveLength(0);
    });
  });
});

describe('normalizeIndexPredicate', () => {
  it('returns empty string for absent/empty predicates', () => {
    expect(normalizeIndexPredicate(undefined)).toBe('');
    expect(normalizeIndexPredicate(null)).toBe('');
    expect(normalizeIndexPredicate('')).toBe('');
    expect(normalizeIndexPredicate('   ')).toBe('');
  });

  it('collapses whitespace and tightens comparison operators', () => {
    expect(normalizeIndexPredicate("_meta_type   =   'Article'")).toBe(
      "_meta_type='Article'",
    );
  });

  it('strips a leading WHERE keyword', () => {
    expect(normalizeIndexPredicate("WHERE _meta_type = 'Article'")).toBe(
      "_meta_type='Article'",
    );
  });

  it('preserves case inside string literals but lowercases identifiers', () => {
    // Identifiers/keywords are case-insensitive; STI class-name literals are
    // not, so the literal must survive verbatim.
    expect(normalizeIndexPredicate("_Meta_Type = 'ClassA'")).toBe(
      "_meta_type='ClassA'",
    );
  });

  it('normalizes a PostgreSQL-rendered predicate to match the manifest form', () => {
    // pg_get_expr / pg_indexes.indexdef wraps predicates in parens and adds
    // ::text casts. These must normalize to the same string as the raw
    // manifest predicate so the differ does not flag false drift on Postgres.
    const manifest = normalizeIndexPredicate("_meta_type = 'Article'");
    const postgres = normalizeIndexPredicate(
      "((_meta_type)::text = 'Article'::text)",
    );
    expect(postgres).toBe(manifest);
    expect(postgres).toBe("_meta_type='Article'");
  });

  it('distinguishes predicates that differ only by their literal', () => {
    expect(normalizeIndexPredicate("_meta_type = 'ClassA'")).not.toBe(
      normalizeIndexPredicate("_meta_type = 'ClassB'"),
    );
  });
});

describe('extractIndexPredicate', () => {
  it('extracts and normalizes the WHERE tail of a SQLite CREATE INDEX', () => {
    expect(
      extractIndexPredicate(
        "CREATE INDEX idx ON t(owner_id) WHERE _meta_type = 'ClassA'",
      ),
    ).toBe("_meta_type='ClassA'");
  });

  it('extracts and normalizes the WHERE tail of a PostgreSQL indexdef', () => {
    expect(
      extractIndexPredicate(
        "CREATE INDEX idx ON public.t USING btree (owner_id) WHERE ((_meta_type)::text = 'ClassA'::text)",
      ),
    ).toBe("_meta_type='ClassA'");
  });

  it('returns empty string for a non-partial index', () => {
    expect(extractIndexPredicate('CREATE INDEX idx ON t(owner_id)')).toBe('');
  });
});
