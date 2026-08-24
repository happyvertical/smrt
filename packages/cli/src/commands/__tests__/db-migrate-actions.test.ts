import { describe, expect, it } from 'vitest';
import {
  getSyntheticMigrationNameForChange,
  getUnresolvedGeneratedMigrationNames,
  partitionSchemaChanges,
  shouldApplySchemaMigrations,
  shouldFailDbMigrate,
  summarizeFailedMigrations,
} from '../db-migrate-actions.js';

describe('partitionSchemaChanges', () => {
  it('keeps type upgrades in the executable migration set', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_upgrade',
          table: 'contents',
          name: 'published_at',
          column: {
            type: 'TIMESTAMP',
          },
          mismatch: {
            expected: 'TIMESTAMP',
            actual: 'TEXT',
          },
          sql: 'ALTER TABLE "contents" ALTER COLUMN "published_at" TYPE TIMESTAMP',
        },
      ],
      (tableName) => `${tableName}:Class`,
    );

    expect(manualInterventions).toEqual([]);
    expect(migrations).toEqual([
      {
        type: 'type_upgrade',
        tableName: 'contents',
        className: 'contents:Class',
        column: {
          name: 'published_at',
          type: 'TIMESTAMP',
          notNull: undefined,
          defaultValue: undefined,
          unique: undefined,
        },
        mismatch: {
          column: 'published_at',
          expected: 'TIMESTAMP',
          actual: 'TEXT',
        },
        sql: 'ALTER TABLE "contents" ALTER COLUMN "published_at" TYPE TIMESTAMP',
      },
    ]);
  });

  it('preserves ordered multi-statement SQL for executable type upgrades', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_upgrade',
          table: 'ad_campaigns',
          name: 'target_clicks',
          column: {
            type: 'INTEGER',
          },
          mismatch: {
            expected: 'INTEGER',
            actual: 'REAL',
          },
          sql: 'ALTER TABLE "ad_campaigns" ALTER COLUMN "target_clicks" TYPE INTEGER USING "target_clicks"::integer',
          sqlStatements: [
            'DO $$ BEGIN IF EXISTS (SELECT 1 FROM "ad_campaigns" WHERE "target_clicks" IS NOT NULL AND "target_clicks" <> trunc("target_clicks")) THEN RAISE EXCEPTION \'Cannot convert ad_campaigns.target_clicks to INTEGER: found non-integer values\'; END IF; END $$',
            'ALTER TABLE "ad_campaigns" ALTER COLUMN "target_clicks" TYPE INTEGER USING "target_clicks"::integer',
          ],
        },
      ],
      () => 'AdCampaign',
    );

    expect(manualInterventions).toEqual([]);
    expect(migrations).toHaveLength(1);
    expect(migrations[0].sqlStatements).toHaveLength(2);
    expect(migrations[0].sqlStatements?.[0]).toContain('DO $$ BEGIN IF EXISTS');
    expect(migrations[0].sqlStatements?.[1]).toContain('ALTER TABLE');
  });

  it('keeps comment-only SQLite type upgrades in the manual intervention set', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_upgrade',
          table: 'contents',
          name: 'metadata',
          column: {
            type: 'JSON',
          },
          mismatch: {
            expected: 'JSON',
            actual: 'BLOB',
          },
          sql: '-- SQLite: Type upgrade for "metadata" requires table recreation',
        },
      ],
      () => 'Content',
    );

    expect(migrations).toEqual([]);
    expect(manualInterventions).toEqual([
      {
        type: 'type_upgrade',
        tableName: 'contents',
        className: 'Content',
        column: {
          name: 'metadata',
          type: 'JSON',
          notNull: undefined,
          defaultValue: undefined,
          unique: undefined,
        },
        mismatch: {
          column: 'metadata',
          expected: 'JSON',
          actual: 'BLOB',
        },
        sql: '-- SQLite: Type upgrade for "metadata" requires table recreation',
      },
    ]);
  });

  it('executes a SQLite table-rebuild type upgrade instead of asking for manual work (#2370)', () => {
    // The differ now answers a SQLite type change with the executable
    // table-rebuild plan. It must land in the executable migration set —
    // `db:migrate` exiting 1 on "manual intervention" was the whole bug.
    const rebuild = [
      'PRAGMA defer_foreign_keys = ON',
      'DROP TABLE IF EXISTS "_smrt_rebuild_contents"',
      'CREATE TABLE "_smrt_rebuild_contents" (\n  "id" TEXT PRIMARY KEY,\n  "score" REAL\n)',
      'INSERT INTO "_smrt_rebuild_contents" ("id", "score") SELECT "id", "score" FROM "contents"',
      'DROP TABLE "contents"',
      'PRAGMA legacy_alter_table = ON',
      'ALTER TABLE "_smrt_rebuild_contents" RENAME TO "contents"',
      'PRAGMA legacy_alter_table = OFF',
    ];

    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_upgrade',
          table: 'contents',
          name: 'score',
          column: { type: 'REAL' },
          mismatch: { expected: 'REAL', actual: 'INTEGER' },
          sql: rebuild[0],
          sqlStatements: rebuild,
        },
      ],
      () => 'Content',
    );

    expect(manualInterventions).toEqual([]);
    expect(migrations).toHaveLength(1);
    expect(migrations[0].type).toBe('type_upgrade');
    expect(migrations[0].sqlStatements).toEqual(rebuild);
  });

  it('drops no-op type upgrades from the action lists', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_upgrade',
          table: 'contents',
          name: 'metadata',
          column: {
            type: 'JSON',
          },
          mismatch: {
            expected: 'JSON',
            actual: 'TEXT',
          },
          sql: '-- SQLite: "metadata" already stores JSON as TEXT (no change needed)',
        },
      ],
      () => 'Content',
    );

    expect(migrations).toEqual([]);
    expect(manualInterventions).toEqual([]);
  });

  it('preserves drop_index changes (issue #1165 shape-drift repair)', () => {
    // The shape-drift repair emits drop_index + add_index in change order.
    // partitionSchemaChanges must surface BOTH in the executable migration
    // set with the drop preceding the add — otherwise the add's IF NOT
    // EXISTS silently no-ops against the wrong-shape index that's still
    // there, and the migration looks "successful" but changes nothing.
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'drop_index',
          table: 'tenants',
          name: 'tenants_slug_context_meta_type_idx',
          sql: 'DROP INDEX IF EXISTS "tenants_slug_context_meta_type_idx"',
        },
        {
          type: 'add_index',
          table: 'tenants',
          name: 'tenants_slug_context_meta_type_idx',
          index: {
            name: 'tenants_slug_context_meta_type_idx',
            columns: ['slug', 'context', '_meta_type'],
            unique: true,
          },
          sql: 'CREATE UNIQUE INDEX "tenants_slug_context_meta_type_idx" ON "tenants" ("slug", "context", "_meta_type")',
        },
      ],
      () => 'Tenant',
    );

    expect(manualInterventions).toEqual([]);
    expect(migrations).toHaveLength(2);
    expect(migrations[0]).toEqual({
      type: 'drop_index',
      tableName: 'tenants',
      className: 'Tenant',
      indexName: 'tenants_slug_context_meta_type_idx',
      sql: 'DROP INDEX IF EXISTS "tenants_slug_context_meta_type_idx"',
    });
    expect(migrations[1].type).toBe('add_index');
    expect(migrations[1].index?.unique).toBe(true);
  });

  it('skips drop_index when name is missing', () => {
    const { migrations } = partitionSchemaChanges(
      [
        {
          type: 'drop_index',
          table: 'tenants',
          // no name — invalid input, must be skipped not crashed
          sql: 'DROP INDEX IF EXISTS ""',
        },
      ],
      () => 'Tenant',
    );

    expect(migrations).toHaveLength(0);
  });

  it('separates incompatible type mismatches from executable repairs', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_mismatch',
          table: 'contents',
          name: 'video_asset_id',
          mismatch: {
            expected: 'TEXT',
            actual: 'INTEGER',
          },
        },
      ],
      () => 'Content',
    );

    expect(migrations).toEqual([]);
    expect(manualInterventions).toEqual([
      {
        type: 'type_mismatch',
        tableName: 'contents',
        className: 'Content',
        mismatch: {
          column: 'video_asset_id',
          expected: 'TEXT',
          actual: 'INTEGER',
        },
      },
    ]);
  });

  it('separates executable PostgreSQL foreign keys from manual engine repairs', () => {
    const executable = {
      type: 'add_foreign_key' as const,
      table: 'children',
      name: 'children_parent_id_parents_id_fkey',
      sqlStatements: [
        'ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_parents_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") NOT VALID',
        'ALTER TABLE "children" VALIDATE CONSTRAINT "children_parent_id_parents_id_fkey"',
      ],
    };
    const manual = {
      type: 'add_foreign_key' as const,
      table: 'orphans',
      name: 'orphans_parent_id_parents_id_fkey',
      advisory: {
        severity: 'warning' as const,
        message: 'Repair existing orphan rows, then rerun.',
        suggestedSql: ['SELECT parent_id FROM orphans'],
      },
    };

    const result = partitionSchemaChanges(
      [executable, manual],
      (table) => `${table}:Class`,
    );

    expect(result.migrations).toEqual([
      expect.objectContaining({
        type: 'add_foreign_key',
        tableName: 'children',
        sqlStatements: executable.sqlStatements,
      }),
    ]);
    expect(result.manualInterventions).toEqual([
      expect.objectContaining({
        type: 'add_foreign_key',
        tableName: 'orphans',
        advisory: manual.advisory,
      }),
    ]);
    expect(getSyntheticMigrationNameForChange(executable)).toMatch(
      /^add_foreign_key_children_[a-f0-9]{8}$/,
    );
  });
});

describe('shouldFailDbMigrate', () => {
  it('fails non-dry-run migrations when manual drift remains', () => {
    expect(shouldFailDbMigrate({ manualInterventionCount: 1 })).toBe(true);
  });

  it('allows dry-run previews of manual drift', () => {
    expect(
      shouldFailDbMigrate({ manualInterventionCount: 1, dryRun: true }),
    ).toBe(false);
  });

  it('fails when table creation or tracking fails', () => {
    expect(shouldFailDbMigrate({ tableErrorCount: 1 })).toBe(true);
  });

  it('fails when STI repair has errors', () => {
    expect(shouldFailDbMigrate({ stiErrorCount: 1 })).toBe(true);
  });

  it('passes when no blocking migration work remains', () => {
    expect(
      shouldFailDbMigrate({
        manualInterventionCount: 0,
        tableErrorCount: 0,
        migrationErrorCount: 0,
        stiErrorCount: 0,
      }),
    ).toBe(false);
  });
});

describe('shouldApplySchemaMigrations', () => {
  it('does not apply schema migrations during dry-run', () => {
    expect(shouldApplySchemaMigrations({ dryRun: true })).toBe(false);
  });

  it('applies schema migrations when dry-run is not requested', () => {
    expect(shouldApplySchemaMigrations({ dryRun: false })).toBe(true);
    expect(shouldApplySchemaMigrations({})).toBe(true);
  });
});

describe('failed migration classification', () => {
  it('tracks current unresolved generated repairs separately from superseded failures', () => {
    const typeUpgrade = {
      type: 'type_upgrade' as const,
      table: 'contents',
      name: 'status',
      sql: 'ALTER TABLE contents ALTER COLUMN status TYPE JSONB USING status::jsonb',
    };
    const typeUpgradeName = getSyntheticMigrationNameForChange(typeUpgrade);
    if (!typeUpgradeName) throw new Error('expected type-upgrade migration id');
    const unresolvedNames = getUnresolvedGeneratedMigrationNames([
      {
        type: 'add_column',
        table: 'contents',
        name: 'script_text',
        column: { type: 'TEXT' },
      },
      typeUpgrade,
    ]);

    expect(
      summarizeFailedMigrations(
        [
          {
            name: 'add_column_contents_script_text',
            error_message: 'column missing',
          },
          {
            name: 'add_index_idx_contents_published_at',
            error_message: 'index already exists',
          },
          {
            name: typeUpgradeName,
            error_message: 'cannot cast',
          },
        ],
        unresolvedNames,
      ),
    ).toEqual({
      unresolved: [
        {
          name: 'add_column_contents_script_text',
          classification: 'unresolved',
          recommendation:
            'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed generated schema repair no longer appears as unresolved.',
          errorMessage: 'column missing',
        },
        {
          name: typeUpgradeName,
          classification: 'unresolved',
          recommendation:
            'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed generated schema repair no longer appears as unresolved.',
          errorMessage: 'cannot cast',
        },
      ],
      superseded: [
        {
          name: 'add_index_idx_contents_published_at',
          classification: 'superseded',
          recommendation:
            'No current live-schema drift maps to this failed generated schema repair. Keep the row for audit history, but it no longer blocks the current schema.',
          errorMessage: 'index already exists',
        },
      ],
      other: [],
    });
  });

  it('tracks drop_index changes as unresolved when present in the live diff', () => {
    // Issue #1165 — synthetic name for a drop must roundtrip through the
    // unresolved/superseded classifier so a failed shape-drift drop shows
    // up in the right bucket on `smrt db:status`.
    //
    // The synthetic name now embeds a short SQL fingerprint to avoid
    // checksum collisions when an index is recreated under the same name
    // with a different shape across migrate runs. The classifier matches
    // by `drop_index_` prefix, so the fingerprint suffix doesn't change
    // routing — but assertions on exact names must use the same name on
    // both sides of the comparison (i.e., feed the SAME `change.sql` into
    // both the unresolved-set builder and the failed-migration record).
    const failedSql =
      'DROP INDEX IF EXISTS "tenants_slug_context_meta_type_idx"';
    const unresolvedNames = getUnresolvedGeneratedMigrationNames([
      {
        type: 'drop_index',
        table: 'tenants',
        name: 'tenants_slug_context_meta_type_idx',
        sql: failedSql,
      },
    ]);

    // The unresolved set should contain exactly one drop_index_* entry.
    const dropEntries = [...unresolvedNames].filter((n) =>
      n.startsWith('drop_index_tenants_slug_context_meta_type_idx_'),
    );
    expect(dropEntries).toHaveLength(1);
    const failedMigrationName = dropEntries[0];

    const summary = summarizeFailedMigrations(
      [
        {
          name: failedMigrationName,
          error_message: 'transient pg lock failure',
        },
      ],
      unresolvedNames,
    );
    expect(summary.unresolved).toHaveLength(1);
    expect(summary.unresolved[0].name).toBe(failedMigrationName);
  });

  it('emits the same synthetic id for the same SQL across runs and a different one when the SQL changes', () => {
    // Same shape twice → same id. Different shape (drift) → different id.
    // This is the property that lets MigrationTracker apply repeat repairs
    // without "checksum mismatch" errors.
    const idA = getUnresolvedGeneratedMigrationNames([
      {
        type: 'add_index',
        table: 'tenants',
        name: 'tenants_slug_context_meta_type_idx',
        index: {
          name: 'tenants_slug_context_meta_type_idx',
          columns: ['slug', 'context', '_meta_type'],
          unique: true,
        },
        sql: 'CREATE UNIQUE INDEX "x" ON "y" ("a", "b", "c")',
      },
    ]);
    const idASame = getUnresolvedGeneratedMigrationNames([
      {
        type: 'add_index',
        table: 'tenants',
        name: 'tenants_slug_context_meta_type_idx',
        index: {
          name: 'tenants_slug_context_meta_type_idx',
          columns: ['slug', 'context', '_meta_type'],
          unique: true,
        },
        sql: 'CREATE UNIQUE INDEX "x" ON "y" ("a", "b", "c")',
      },
    ]);
    const idDrifted = getUnresolvedGeneratedMigrationNames([
      {
        type: 'add_index',
        table: 'tenants',
        name: 'tenants_slug_context_meta_type_idx',
        index: {
          name: 'tenants_slug_context_meta_type_idx',
          columns: ['slug', 'context', '_meta_type'],
          unique: false, // ← shape drifted
        },
        sql: 'CREATE INDEX "x" ON "y" ("a", "b", "c")',
      },
    ]);

    expect([...idA]).toEqual([...idASame]);
    expect([...idA]).not.toEqual([...idDrifted]);
  });

  it('falls back to direct-review classification when live drift comparison is unavailable', () => {
    expect(
      summarizeFailedMigrations(
        [{ name: 'add_column_contents_script_text', error_message: null }],
        null,
      ),
    ).toEqual({
      unresolved: [],
      superseded: [],
      other: [
        {
          name: 'add_column_contents_script_text',
          classification: 'other',
          recommendation:
            'Inspect this failed migration directly. Live schema comparison was unavailable, so SMRT could not determine whether it has been superseded.',
          errorMessage: null,
        },
      ],
    });
  });
});
