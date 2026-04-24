import { describe, expect, it } from 'vitest';
import {
  getUnresolvedGeneratedMigrationNames,
  partitionSchemaChanges,
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

  it('fails when STI upgrade has errors', () => {
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

describe('failed migration classification', () => {
  it('tracks current unresolved generated repairs separately from superseded failures', () => {
    const unresolvedNames = getUnresolvedGeneratedMigrationNames([
      {
        type: 'add_column',
        table: 'contents',
        name: 'script_text',
        column: { type: 'TEXT' },
      },
      {
        type: 'type_upgrade',
        table: 'contents',
        name: 'status',
        sql: 'ALTER TABLE contents ALTER COLUMN status TYPE JSONB USING status::jsonb',
      },
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
            name: 'type_upgrade_contents_status',
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
          name: 'type_upgrade_contents_status',
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
