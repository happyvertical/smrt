import { describe, expect, it } from 'vitest';
import {
  classifyTypeUpgradeSql,
  getSyntheticMigrationNameForAction,
  getSyntheticMigrationNameForChange,
  getUnresolvedGeneratedMigrationNames,
  partitionSchemaChanges,
} from '../db-migrate-actions.js';

/**
 * Synthetic migration-name derivation and schema-change partitioning.
 *
 * These are the pure helpers `db:migrate` / `db:status` use to give each
 * generated schema repair a stable tracker id (with a shape fingerprint so a
 * recreated index of a different shape gets a fresh row) and to split a schema
 * diff into auto-applicable migrations vs. manual interventions.
 */
describe('classifyTypeUpgradeSql', () => {
  it('treats an empty/undefined sql as manual', () => {
    expect(classifyTypeUpgradeSql(undefined)).toBe('manual');
    expect(classifyTypeUpgradeSql('   ')).toBe('manual');
  });

  it('treats a real SQL statement as executable', () => {
    expect(
      classifyTypeUpgradeSql(
        'ALTER TABLE contents ALTER COLUMN status TYPE jsonb',
      ),
    ).toBe('executable');
  });

  it('treats a "no change needed" comment as a no-op', () => {
    expect(
      classifyTypeUpgradeSql(
        '-- SQLite: "metadata" already stores JSON as TEXT (no change needed)',
      ),
    ).toBe('noop');
  });

  it('treats a non-no-op comment as manual', () => {
    expect(
      classifyTypeUpgradeSql(
        '-- SQLite: type upgrade requires table recreation',
      ),
    ).toBe('manual');
  });
});

describe('getSyntheticMigrationNameForAction', () => {
  it('names an add_column action', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'add_column',
        tableName: 'widgets',
        className: 'Widget',
        column: { name: 'price', type: 'REAL' },
      } as any),
    ).toBe('add_column_widgets_price');
  });

  it('returns null for an add_column action with no column', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'add_column',
        tableName: 'widgets',
        className: 'Widget',
      } as any),
    ).toBeNull();
  });

  it('names an add_index action with a shape fingerprint from the index', () => {
    const name = getSyntheticMigrationNameForAction({
      type: 'add_index',
      tableName: 'widgets',
      className: 'Widget',
      index: { name: 'idx_widgets_name', columns: ['name'], unique: false },
    } as any);
    expect(name).toMatch(/^add_index_idx_widgets_name_[0-9a-f]{8}$/);
  });

  it('uses provided SQL statements for the add_index fingerprint', () => {
    const name = getSyntheticMigrationNameForAction({
      type: 'add_index',
      tableName: 'widgets',
      className: 'Widget',
      index: { name: 'idx_widgets_name', columns: ['name'] },
      sqlStatements: ['CREATE INDEX idx_widgets_name ON widgets(name)'],
    } as any);
    expect(name).toMatch(/^add_index_idx_widgets_name_[0-9a-f]{8}$/);
  });

  it('returns null for an add_index action with no index', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'add_index',
        tableName: 'widgets',
        className: 'Widget',
      } as any),
    ).toBeNull();
  });

  it('names a drop_index action with a fingerprint', () => {
    const name = getSyntheticMigrationNameForAction({
      type: 'drop_index',
      tableName: 'widgets',
      className: 'Widget',
      indexName: 'idx_orphan',
      sql: 'DROP INDEX idx_orphan',
    } as any);
    expect(name).toMatch(/^drop_index_idx_orphan_[0-9a-f]{8}$/);
  });

  it('falls back to the bare drop_index name when no fingerprint material exists', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'drop_index',
        tableName: 'widgets',
        className: 'Widget',
        indexName: 'idx_orphan',
      } as any),
    ).toBe('drop_index_idx_orphan');
  });

  it('returns null for a drop_index action with no index name', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'drop_index',
        tableName: 'widgets',
        className: 'Widget',
      } as any),
    ).toBeNull();
  });

  it('names a type_upgrade action and returns null without a column', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'type_upgrade',
        tableName: 'widgets',
        className: 'Widget',
        column: { name: 'status', type: 'TEXT' },
      } as any),
    ).toBe('type_upgrade_widgets_status');
    expect(
      getSyntheticMigrationNameForAction({
        type: 'type_upgrade',
        tableName: 'widgets',
        className: 'Widget',
      } as any),
    ).toBeNull();
  });

  it('returns null for an unknown action type', () => {
    expect(
      getSyntheticMigrationNameForAction({
        type: 'drop_table',
        tableName: 'widgets',
        className: 'Widget',
      } as any),
    ).toBeNull();
  });
});

describe('getSyntheticMigrationNameForChange', () => {
  it('names an add_column change and guards a missing name', () => {
    expect(
      getSyntheticMigrationNameForChange({
        type: 'add_column',
        table: 'widgets',
        name: 'price',
      } as any),
    ).toBe('add_column_widgets_price');
    expect(
      getSyntheticMigrationNameForChange({
        type: 'add_column',
        table: 'widgets',
      } as any),
    ).toBeNull();
  });

  it('derives the add_index name from change.index.name or change.name', () => {
    expect(
      getSyntheticMigrationNameForChange({
        type: 'add_index',
        table: 'widgets',
        index: { name: 'idx_a', columns: ['a'] },
      } as any),
    ).toMatch(/^add_index_idx_a_[0-9a-f]{8}$/);
    expect(
      getSyntheticMigrationNameForChange({
        type: 'add_index',
        table: 'widgets',
        name: 'idx_b',
      } as any),
    ).toBe('add_index_idx_b');
    expect(
      getSyntheticMigrationNameForChange({
        type: 'add_index',
        table: 'widgets',
      } as any),
    ).toBeNull();
  });

  it('names a drop_index change with and without a fingerprint', () => {
    expect(
      getSyntheticMigrationNameForChange({
        type: 'drop_index',
        table: 'widgets',
        name: 'idx_orphan',
        sql: 'DROP INDEX idx_orphan',
      } as any),
    ).toMatch(/^drop_index_idx_orphan_[0-9a-f]{8}$/);
    expect(
      getSyntheticMigrationNameForChange({
        type: 'drop_index',
        table: 'widgets',
        name: 'idx_orphan',
      } as any),
    ).toBe('drop_index_idx_orphan');
    expect(
      getSyntheticMigrationNameForChange({
        type: 'drop_index',
        table: 'widgets',
      } as any),
    ).toBeNull();
  });

  it('names a type_upgrade change and returns null for unknown types', () => {
    expect(
      getSyntheticMigrationNameForChange({
        type: 'type_upgrade',
        table: 'widgets',
        name: 'status',
      } as any),
    ).toBe('type_upgrade_widgets_status');
    expect(
      getSyntheticMigrationNameForChange({
        type: 'drop_table',
        table: 'widgets',
      } as any),
    ).toBeNull();
  });
});

describe('getUnresolvedGeneratedMigrationNames', () => {
  it('skips no-op type upgrades and unrelated change types', () => {
    const names = getUnresolvedGeneratedMigrationNames([
      { type: 'add_column', table: 'widgets', name: 'price' },
      {
        type: 'type_upgrade',
        table: 'widgets',
        name: 'metadata',
        sql: '-- already stores JSON as TEXT (no change needed)',
      },
      { type: 'drop_table', table: 'widgets' },
    ] as any);

    expect(names.has('add_column_widgets_price')).toBe(true);
    expect(names.has('type_upgrade_widgets_metadata')).toBe(false);
  });
});

describe('partitionSchemaChanges index + guard branches', () => {
  const getClassForTable = (table: string) => `${table}Class`;

  it('partitions add_index and drop_index into executable migrations', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'add_index',
          table: 'widgets',
          index: { name: 'idx_a', columns: ['a'], unique: true },
          sql: 'CREATE UNIQUE INDEX idx_a ON widgets(a)',
        },
        {
          type: 'drop_index',
          table: 'widgets',
          name: 'idx_old',
          sql: 'DROP INDEX idx_old',
        },
      ] as any,
      getClassForTable,
    );

    expect(migrations.map((m) => m.type)).toEqual(['add_index', 'drop_index']);
    expect(manualInterventions).toEqual([]);
  });

  it('skips malformed add_index/drop_index/add_column/type changes', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        { type: 'add_index', table: 'widgets' }, // no index → skipped
        { type: 'drop_index', table: 'widgets' }, // no name → skipped
        { type: 'add_column', table: 'widgets' }, // no name/column → skipped
        { type: 'type_mismatch', table: 'widgets' }, // no name/mismatch → skipped
        { type: 'type_upgrade', table: 'widgets', name: 'x' }, // no mismatch → skipped
      ] as any,
      getClassForTable,
    );

    expect(migrations).toEqual([]);
    expect(manualInterventions).toEqual([]);
  });

  it('routes a type_mismatch into manual interventions', () => {
    const { migrations, manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'type_mismatch',
          table: 'widgets',
          name: 'status',
          mismatch: { expected: 'TEXT', actual: 'INTEGER' },
        },
      ] as any,
      getClassForTable,
    );

    expect(migrations).toEqual([]);
    expect(manualInterventions[0]).toMatchObject({
      type: 'type_mismatch',
      tableName: 'widgets',
    });
  });
});
