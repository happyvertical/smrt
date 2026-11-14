import { describe, expect, it } from 'vitest';
import {
  getSyntheticMigrationNameForAction,
  getSyntheticMigrationNameForChange,
  getUnresolvedGeneratedMigrationNames,
  partitionSchemaChanges,
  type SchemaChangeLike,
} from '../db-migrate-actions.js';

const drop: SchemaChangeLike = {
  type: 'retire_table',
  kindHint: 'table.retire',
  table: 'old_drafts',
  sql: 'DROP TABLE IF EXISTS "old_drafts"',
  note: 'Retired in 1.2.0 (@acme:Draft): moved.',
};
const stop: SchemaChangeLike = {
  type: 'retire_table',
  kindHint: 'table.retire-dependent',
  table: 'old_drafts',
  advisory: {
    severity: 'warning',
    message: 'foreign key child.p depends on it.',
  },
};

describe('retired tables in db:migrate (#5005)', () => {
  it.each([
    'postgres',
    'sqlite',
    'duckdb',
  ] as const)('applies the drop and stops the rest on %s', (engine) => {
    const { migrations, manualInterventions, advisories } =
      partitionSchemaChanges([drop, stop], (table) => table, engine);
    expect(advisories).toEqual([]);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      type: 'retire_table',
      tableName: 'old_drafts',
      sql: 'DROP TABLE IF EXISTS "old_drafts"',
      note: 'Retired in 1.2.0 (@acme:Draft): moved.',
    });
    expect(manualInterventions).toHaveLength(1);
    expect(manualInterventions[0]).toMatchObject({
      kind: 'table.retire-dependent',
      stopReason: { reason: 'loses-data' },
    });
    expect(manualInterventions[0].decisionMessage).toContain(
      'foreign key child.p depends on it.',
    );
  });

  it('names the tracker migration by table, so a rerun reconciles it', () => {
    expect(getSyntheticMigrationNameForChange(drop)).toBe(
      'retire_table_old_drafts',
    );
    const [action] = partitionSchemaChanges(
      [drop],
      (table) => table,
      'sqlite',
    ).migrations;
    expect(getSyntheticMigrationNameForAction(action)).toBe(
      'retire_table_old_drafts',
    );
  });

  it('counts a failed retire as unresolved while it is still planned, not a stop', () => {
    expect(
      getUnresolvedGeneratedMigrationNames([drop, stop], 'sqlite'),
    ).toEqual(new Set(['retire_table_old_drafts']));
  });
});
