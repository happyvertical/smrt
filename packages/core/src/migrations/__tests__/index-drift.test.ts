/**
 * Tests for index drift detection in SchemaComparer.
 *
 * Covers two repair paths the differ now emits:
 *
 * - **Same-name shape drift** — DB has an index with the manifest's name but
 *   different columns or uniqueness. The differ emits drop_index + add_index
 *   so the next migration recreates it correctly. This is the failure mode
 *   from issue #1165 (`tenants_slug_context_meta_type_idx` materialized
 *   non-unique while the manifest declared it unique, breaking PostgreSQL
 *   UPSERT against the STI conflict target).
 *
 * - **Orphan in DB** — DB carries an index the manifest no longer references.
 *   Emitted only when the caller opts in via `includeDroppedIndexes`, and
 *   never for `*_pkey` / `*_key` (PostgreSQL implicit-from-constraint
 *   indexes that need a separate DROP CONSTRAINT path the differ does not
 *   own yet).
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { SchemaComparer } from '../differ.js';

function tableSchema(
  overrides: Partial<SchemaDefinition> = {},
): SchemaDefinition {
  return {
    tableName: 'tenants',
    ddl: 'CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, context TEXT, _meta_type TEXT);',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      slug: { type: 'TEXT' },
      context: { type: 'TEXT' },
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

describe('SchemaComparer index drift', () => {
  let db: DatabaseProvider;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      'CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, context TEXT, _meta_type TEXT);',
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

  describe('same-name shape drift (issue #1165)', () => {
    it('recreates an index whose uniqueness flag drifted (non-unique → unique)', async () => {
      // The bug: index exists with the right name and columns but NOT unique.
      // PostgreSQL UPSERT against ON CONFLICT(slug, context, _meta_type)
      // can't bind to it because no unique constraint matches.
      await db.query(
        'CREATE INDEX tenants_slug_context_meta_type_idx ON tenants(slug, context, _meta_type);',
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'tenants_slug_context_meta_type_idx',
              columns: ['slug', 'context', '_meta_type'],
              unique: true,
            },
          ],
        }),
      });

      const indexChanges = diff.changes.filter(
        (c) =>
          c.name === 'tenants_slug_context_meta_type_idx' &&
          (c.type === 'drop_index' || c.type === 'add_index'),
      );

      expect(indexChanges).toHaveLength(2);
      // Drop must come before add so SQLite/Postgres can recreate the name.
      expect(indexChanges[0].type).toBe('drop_index');
      expect(indexChanges[1].type).toBe('add_index');
      expect(indexChanges[1].index?.unique).toBe(true);
    });

    it('recreates an index whose columns drifted', async () => {
      // Same name, different columns — still a recreate.
      await db.query('CREATE INDEX idx_tenants_lookup ON tenants(slug);');

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'idx_tenants_lookup',
              columns: ['slug', 'context'],
              unique: false,
            },
          ],
        }),
      });

      const recreate = diff.changes.filter(
        (c) =>
          c.name === 'idx_tenants_lookup' &&
          (c.type === 'drop_index' || c.type === 'add_index'),
      );

      expect(recreate.map((c) => c.type)).toEqual(['drop_index', 'add_index']);
      expect(recreate[1].index?.columns).toEqual(['slug', 'context']);
    });

    it('does not flag drift when name and shape both match', async () => {
      await db.query(
        'CREATE UNIQUE INDEX tenants_slug_context_meta_type_idx ON tenants(slug, context, _meta_type);',
      );

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'tenants_slug_context_meta_type_idx',
              columns: ['slug', 'context', '_meta_type'],
              unique: true,
            },
          ],
        }),
      });

      const indexChanges = diff.changes.filter(
        (c) => c.type === 'add_index' || c.type === 'drop_index',
      );
      expect(indexChanges).toHaveLength(0);
    });
  });

  describe('orphan-index drops', () => {
    it('does not drop orphans by default (safety)', async () => {
      await db.query('CREATE INDEX tenants_legacy_idx ON tenants(slug);');

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({ tenants: tableSchema() });

      const drops = diff.changes.filter((c) => c.type === 'drop_index');
      expect(drops).toHaveLength(0);
    });

    it('drops orphan indexes when includeDroppedIndexes is enabled', async () => {
      await db.query(
        'CREATE UNIQUE INDEX tenants_slug_context_idx ON tenants(slug, context);',
      );

      const comparer = new SchemaComparer(db, {
        includeDroppedIndexes: true,
      });
      const diff = await comparer.compare({
        tenants: tableSchema({
          // Manifest no longer wants the 2-column unique — the new STI shape
          // is on (slug, context, _meta_type).
          indexes: [
            {
              name: 'tenants_slug_context_meta_type_idx',
              columns: ['slug', 'context', '_meta_type'],
              unique: true,
            },
          ],
        }),
      });

      const droppedNames = diff.changes
        .filter((c) => c.type === 'drop_index')
        .map((c) => c.name);
      expect(droppedNames).toContain('tenants_slug_context_idx');
    });

    it('never drops *_pkey / *_key (implicit-from-constraint indexes)', async () => {
      // The differ doesn't emit DROP CONSTRAINT, so it must not drop the
      // implicit indexes those constraints own — the constraint would still
      // be there but the index would be gone, breaking the table.
      await db.query(
        'CREATE TABLE constrained (id TEXT PRIMARY KEY, slug TEXT, context TEXT, UNIQUE(slug, context));',
      );

      const comparer = new SchemaComparer(db, {
        includeDroppedIndexes: true,
      });
      const diff = await comparer.compare({
        constrained: {
          tableName: 'constrained',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            slug: { type: 'TEXT' },
            context: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      });

      const dropped = diff.changes
        .filter((c) => c.type === 'drop_index')
        .map((c) => c.name ?? '');

      // No protected name should be dropped, regardless of which suffix the
      // engine used (`_pkey` for PG, `sqlite_autoindex_*` for SQLite — the
      // SQLite case is filtered upstream by the introspection layer).
      for (const name of dropped) {
        expect(name.endsWith('_pkey')).toBe(false);
        expect(name.endsWith('_key')).toBe(false);
      }
    });

    it('keeps a DB index that is signature-equivalent to a manifest index under a different name (issue #741)', async () => {
      await db.query(
        'CREATE UNIQUE INDEX renamed_unique ON tenants(slug, context, _meta_type);',
      );

      const comparer = new SchemaComparer(db, {
        includeDroppedIndexes: true,
      });
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'tenants_slug_context_meta_type_idx',
              columns: ['slug', 'context', '_meta_type'],
              unique: true,
            },
          ],
        }),
      });

      // Should NOT add (signature already covered) and should NOT drop
      // the equivalent existing index.
      expect(
        diff.changes.filter(
          (c) => c.type === 'add_index' || c.type === 'drop_index',
        ),
      ).toHaveLength(0);
    });
  });

  describe('issue #1165 anytown.ai scenario', () => {
    it('emits the right repair plan for a deployed-stale tenants schema', async () => {
      // Recreate the live anytown.ai shape from the issue:
      // - tenants_id_idx (id) non-unique
      // - tenants_meta_type_idx (_meta_type) non-unique
      // - tenants_slug_context_idx UNIQUE (slug, context)         ← stale
      // - tenants_slug_context_meta_type_idx (slug, context, _meta_type) non-unique  ← broken
      await db.query('CREATE INDEX tenants_id_idx ON tenants(id);');
      await db.query(
        'CREATE INDEX tenants_meta_type_idx ON tenants(_meta_type);',
      );
      await db.query(
        'CREATE UNIQUE INDEX tenants_slug_context_idx ON tenants(slug, context);',
      );
      await db.query(
        'CREATE INDEX tenants_slug_context_meta_type_idx ON tenants(slug, context, _meta_type);',
      );

      const comparer = new SchemaComparer(db, {
        includeDroppedIndexes: true,
      });
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'tenants_id_idx',
              columns: ['id'],
              unique: false,
            },
            {
              name: 'tenants_meta_type_idx',
              columns: ['_meta_type'],
              unique: false,
            },
            {
              name: 'tenants_slug_context_meta_type_idx',
              columns: ['slug', 'context', '_meta_type'],
              unique: true,
            },
          ],
        }),
      });

      const byTypeAndName = diff.changes
        .filter((c) => c.type === 'add_index' || c.type === 'drop_index')
        .map((c) => `${c.type}:${c.name}`);

      // The broken non-unique index gets dropped and recreated as unique.
      expect(byTypeAndName).toContain(
        'drop_index:tenants_slug_context_meta_type_idx',
      );
      expect(byTypeAndName).toContain(
        'add_index:tenants_slug_context_meta_type_idx',
      );

      // The stale 2-column unique gets dropped (orphan).
      expect(byTypeAndName).toContain('drop_index:tenants_slug_context_idx');

      // The unrelated maintenance indexes are untouched.
      expect(byTypeAndName).not.toContain('drop_index:tenants_id_idx');
      expect(byTypeAndName).not.toContain('drop_index:tenants_meta_type_idx');
    });
  });
});
