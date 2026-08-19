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
import { shortenIdentifier } from '../../schema/index-utils.js';
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

    describe('redundant primary-key index (#2359, A5)', () => {
      it('drops the legacy <table>_id_idx without --drop-indexes once the manifest stops declaring it', async () => {
        // Every generator path used to emit this beside the engine's own
        // primary-key index; the differ must clean it up on existing DBs
        // without the orphan-sweep opt-in.
        await db.query('CREATE INDEX tenants_id_idx ON tenants(id);');
        // A genuine orphan on a non-PK column must still be left alone.
        await db.query('CREATE INDEX tenants_legacy_idx ON tenants(slug);');

        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ tenants: tableSchema() });

        const droppedNames = diff.changes
          .filter((c) => c.type === 'drop_index')
          .map((c) => c.name);
        expect(droppedNames).toEqual(['tenants_id_idx']);
        expect(diff.changes.some((c) => c.type === 'add_index')).toBe(false);
      });

      it('applies cleanly and leaves the primary key serving lookups', async () => {
        await db.query('CREATE INDEX tenants_id_idx ON tenants(id);');
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ tenants: tableSchema() });
        for (const change of diff.changes) {
          if (change.sql) await db.query(change.sql);
        }
        const after = await comparer.compare({ tenants: tableSchema() });
        expect(after.changes.filter((c) => c.type === 'drop_index')).toEqual(
          [],
        );
        // The table is still keyed: PRIMARY KEY lookups keep working.
        await db.query(
          "INSERT INTO tenants (id, slug, context, _meta_type) VALUES ('a', 's', '', 'T');",
        );
        await expect(
          db.query(
            "INSERT INTO tenants (id, slug, context, _meta_type) VALUES ('a', 's2', '', 'T');",
          ),
        ).rejects.toThrow();
      });

      it('keeps a primary-key-column index the manifest still declares', async () => {
        await db.query('CREATE INDEX tenants_id_idx ON tenants(id);');
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({
          tenants: tableSchema({
            indexes: [{ name: 'tenants_id_idx', columns: ['id'] }],
          }),
        });
        expect(diff.changes.filter((c) => c.type === 'drop_index')).toEqual([]);
      });

      it('does not treat a single-column index on a non-PK column as redundant', async () => {
        await db.query('CREATE INDEX tenants_slug_only_idx ON tenants(slug);');
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ tenants: tableSchema() });
        expect(diff.changes.filter((c) => c.type === 'drop_index')).toEqual([]);
      });

      it('leaves a single-column index on one column of a COMPOSITE primary key alone', async () => {
        // The composite PK index only serves prefixes; an index on the
        // second column is load-bearing, not redundant.
        await db.query(
          'CREATE TABLE pairs (a TEXT, b TEXT, note TEXT, PRIMARY KEY (a, b));',
        );
        await db.query('CREATE INDEX pairs_b_idx ON pairs(b);');
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({
          pairs: tableSchema({
            tableName: 'pairs',
            ddl: '',
            columns: {
              a: { type: 'TEXT', primaryKey: true },
              b: { type: 'TEXT', primaryKey: true },
              note: { type: 'TEXT' },
            },
          }),
        });
        expect(diff.changes.filter((c) => c.type === 'drop_index')).toEqual([]);
      });

      it('never drops a UNIQUE index on the primary key column (it may back a named PK constraint)', async () => {
        // On PostgreSQL a `CONSTRAINT foo_primary PRIMARY KEY (id)` is listed
        // by introspection (only `*_pkey` is filtered) as a unique index on
        // the PK column; DROP INDEX on it fails and would roll back the
        // atomic migrate batch. The legacy `<table>_id_idx` was never unique.
        await db.query('CREATE UNIQUE INDEX tenants_primary ON tenants(id);');
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ tenants: tableSchema() });
        expect(diff.changes.filter((c) => c.type === 'drop_index')).toEqual([]);
      });
    });

    describe('default list-ordering index (#2363, A2)', () => {
      /**
       * The index wave only helps if `smrt db:migrate` actually adds it to
       * databases created before the generator emitted it — that is the whole
       * point of the epic's schema-path work, and the differ is the component
       * that turns the new manifest index into DDL.
       */
      const orderedTable = (): SchemaDefinition =>
        tableSchema({
          tableName: 'listables',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            slug: { type: 'TEXT' },
            context: { type: 'TEXT' },
            tenant_id: { type: 'TEXT', referenceKind: 'tenantId' },
            created_at: { type: 'TIMESTAMP' },
          },
          indexes: [
            {
              name: 'listables_slug_context_idx',
              columns: ['slug', 'context'],
              unique: true,
            },
            {
              name: 'listables_tenant_id_created_at_idx',
              columns: ['tenant_id', 'created_at'],
            },
          ],
        });

      beforeEach(async () => {
        // A database created before #2363: conflict index only.
        await db.query(
          'CREATE TABLE listables (id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, created_at TIMESTAMP);',
        );
        await db.query(
          'CREATE UNIQUE INDEX listables_slug_context_idx ON listables(slug, context);',
        );
      });

      it('adds the (tenant_id, created_at) index to a pre-#2363 database', async () => {
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ listables: orderedTable() });

        const adds = diff.changes.filter((c) => c.type === 'add_index');
        expect(adds.map((c) => c.name)).toEqual([
          'listables_tenant_id_created_at_idx',
        ]);
        expect(adds[0].sql).toContain('"tenant_id", "created_at"');
        expect(adds[0].sql).not.toContain('UNIQUE');
      });

      it('applies cleanly and then reports no further drift', async () => {
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ listables: orderedTable() });
        for (const change of diff.changes) {
          if (change.sql) await db.query(change.sql);
        }

        const after = await comparer.compare({ listables: orderedTable() });
        expect(
          after.changes.filter(
            (c) => c.type === 'add_index' || c.type === 'drop_index',
          ),
        ).toEqual([]);
      });

      it('leaves the legacy standalone tenant index in place without --drop-indexes', async () => {
        // #2359 shipped `listables_tenant_id_idx`; #2363 replaces it with the
        // composite that already serves the tenant filter. Dropping it is an
        // opt-in orphan sweep, not something a routine migrate does — the
        // composite has to exist and be warm first.
        await db.query(
          'CREATE INDEX listables_tenant_id_idx ON listables(tenant_id);',
        );

        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({ listables: orderedTable() });
        expect(diff.changes.filter((c) => c.type === 'drop_index')).toEqual([]);

        const sweeping = new SchemaComparer(db, {
          includeDroppedIndexes: true,
        });
        const sweep = await sweeping.compare({ listables: orderedTable() });
        expect(
          sweep.changes
            .filter((c) => c.type === 'drop_index')
            .map((c) => c.name),
        ).toEqual(['listables_tenant_id_idx']);
      });
    });

    describe('STI subtype-scoped UNIQUE indexes on engines without partial indexes (#2359)', () => {
      it('neither compares nor creates a descendant-scoped unique index when the engine cannot express it', async () => {
        // The STI descendant-scoped `unique: true` shape is a partial UNIQUE
        // index on `_meta_type`. Degrading it to a full UNIQUE on DuckDB would
        // constrain every subtype's rows, so the differ skips it there
        // entirely (a caller-declared partial unique such as
        // `WHERE active = TRUE` still degrades to a full UNIQUE as before).
        const comparer = new SchemaComparer(db, { engineHint: 'duckdb' });
        const diff = await comparer.compare({
          tenants: tableSchema({
            indexes: [
              {
                name: 'tenants_slug_meeting_unique_idx',
                columns: ['slug'],
                unique: true,
                where: "_meta_type = 'Meeting'",
              },
              // A plain partial index still degrades to a full index as before.
              {
                name: 'tenants_slug_meeting_idx',
                columns: ['slug'],
                where: "_meta_type = 'Meeting'",
              },
            ],
          }),
        });
        const adds = diff.changes
          .filter((c) => c.type === 'add_index')
          .map((c) => c.name);
        expect(adds).toEqual(['tenants_slug_meeting_idx']);
      });

      it('still creates it on SQLite/PostgreSQL, predicate included', async () => {
        const comparer = new SchemaComparer(db);
        const diff = await comparer.compare({
          tenants: tableSchema({
            indexes: [
              {
                name: 'tenants_slug_meeting_unique_idx',
                columns: ['slug'],
                unique: true,
                where: "_meta_type = 'Meeting'",
              },
            ],
          }),
        });
        const add = diff.changes.find((c) => c.type === 'add_index');
        expect(add?.name).toBe('tenants_slug_meeting_unique_idx');
        expect(add?.sql).toContain('UNIQUE');
        expect(add?.sql).toContain("WHERE _meta_type = 'Meeting'");
      });
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

    it('keeps multiple DB indexes that share a signature with a manifest index', async () => {
      // Pathological-but-legal case: two indexes with the same columns
      // and uniqueness under different names. Earlier the comparer's
      // signature map only remembered ONE, so the other got swept by
      // the orphan pass. Both must survive when their signature matches
      // the manifest. (Copilot review on PR #1166.)
      await db.query('CREATE INDEX dup_a ON tenants(slug, context);');
      await db.query('CREATE INDEX dup_b ON tenants(slug, context);');

      const comparer = new SchemaComparer(db, {
        includeDroppedIndexes: true,
      });
      const diff = await comparer.compare({
        tenants: tableSchema({
          indexes: [
            {
              name: 'tenants_slug_context_idx',
              columns: ['slug', 'context'],
              unique: false,
            },
          ],
        }),
      });

      const dropped = diff.changes
        .filter((c) => c.type === 'drop_index')
        .map((c) => c.name);

      // Neither dup_a nor dup_b — both share the manifest signature.
      expect(dropped).not.toContain('dup_a');
      expect(dropped).not.toContain('dup_b');
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

  describe('63-byte identifier guard: existing long names migrate by name swap (#2374)', () => {
    /**
     * The 66-byte index that shipped before the guard. PostgreSQL accepted the
     * CREATE and stored it under the first 63 bytes; `pg_indexes` — which is
     * what the differ introspects — therefore reports the truncated name.
     */
    const LEGACY_NAME =
      'content_contribution_revisions_contribution_id_revision_number_idx';
    /** What the live database actually holds. */
    const TRUNCATED_IN_DB = LEGACY_NAME.slice(0, 63);
    /** What the generator emits now. */
    const GUARDED_NAME = shortenIdentifier(LEGACY_NAME);

    const revisionsSchema = (
      indexes: SchemaDefinition['indexes'],
    ): SchemaDefinition => ({
      tableName: 'content_contribution_revisions',
      ddl: '',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        contribution_id: { type: 'TEXT' },
        revision_number: { type: 'INTEGER' },
      },
      indexes,
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    });

    beforeEach(async () => {
      await db.query(
        'CREATE TABLE content_contribution_revisions (id TEXT PRIMARY KEY, contribution_id TEXT, revision_number INTEGER);',
      );
      // Reproduce what PostgreSQL left behind: the index exists, under the
      // truncated name, with the right shape.
      await db.query(
        `CREATE UNIQUE INDEX "${TRUNCATED_IN_DB}" ON content_contribution_revisions(contribution_id, revision_number);`,
      );
    });

    it('sanity: the legacy name overflowed and the guard produces a different, shorter one', () => {
      expect(LEGACY_NAME.length).toBe(66);
      expect(TRUNCATED_IN_DB).not.toBe(LEGACY_NAME);
      expect(GUARDED_NAME.length).toBeLessThanOrEqual(63);
      expect(GUARDED_NAME).not.toBe(TRUNCATED_IN_DB);
    });

    it('emits no change: the live index is claimed by signature, not by name', async () => {
      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        content_contribution_revisions: revisionsSchema([
          {
            name: GUARDED_NAME,
            columns: ['contribution_id', 'revision_number'],
            unique: true,
          },
        ]),
      });

      // The whole point of the swap: an existing deployment does NOT rebuild
      // the index. It keeps serving under the name PostgreSQL gave it, and the
      // differ recognises it by column set + uniqueness.
      expect(
        diff.changes.filter(
          (c) => c.type === 'add_index' || c.type === 'drop_index',
        ),
      ).toEqual([]);
    });

    it('does not drop the legacy-named index even with includeDroppedIndexes', async () => {
      // The orphan sweep would otherwise see a DB index no manifest entry
      // claims by name. The signature check has to protect it — dropping a
      // UNIQUE index that backs an UPSERT conflict target mid-migration is the
      // expensive failure.
      const comparer = new SchemaComparer(db, { includeDroppedIndexes: true });
      const diff = await comparer.compare({
        content_contribution_revisions: revisionsSchema([
          {
            name: GUARDED_NAME,
            columns: ['contribution_id', 'revision_number'],
            unique: true,
          },
        ]),
      });

      expect(diff.changes.filter((c) => c.type === 'drop_index')).toEqual([]);
    });

    it('creates both indexes when two guarded names share a 63-byte prefix', async () => {
      // The bug the guard closes. Unshortened, these two names are identical
      // for their first 63 bytes, so PostgreSQL stores one and the second
      // `CREATE INDEX IF NOT EXISTS` silently no-ops — leaving the differ to
      // emit `add_index` for it on every run, forever.
      const table = 'content_contribution_revisions';
      const first = shortenIdentifier(`${table}_contribution_id_number_a_idx`);
      const second = shortenIdentifier(`${table}_contribution_id_number_b_idx`);
      expect(first).not.toBe(second);

      const comparer = new SchemaComparer(db);
      const diff = await comparer.compare({
        content_contribution_revisions: revisionsSchema([
          { name: first, columns: ['contribution_id'] },
          { name: second, columns: ['revision_number'] },
        ]),
      });

      expect(
        diff.changes
          .filter((c) => c.type === 'add_index')
          .map((c) => c.name)
          .sort(),
      ).toEqual([first, second].sort());
    });
  });
});
