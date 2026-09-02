/**
 * Issue #2608 — CLI handling of the differ's pre-R11 uuid convergence
 * (`type_upgrade` entries marked `phase: 'pre_foreign_key'`).
 *
 * An executable conversion must reach the migration batch: dropping it while
 * `compareForeignKeys()` already assumed the converged type reintroduces
 * SQLSTATE 42804. A refused convergence carries an advisory and no SQL, and
 * belongs with the other report-only findings — never as a tracker migration.
 */

import { describe, expect, it } from 'vitest';
import {
  getUnresolvedGeneratedMigrationNames,
  partitionSchemaChanges,
  printSchemaAdvisories,
  type SchemaChangeLike,
} from '../db-migrate-actions.js';

const className = (tableName: string) => `${tableName}:Class`;

const conversion: SchemaChangeLike = {
  type: 'type_upgrade',
  table: 'tags',
  name: 'id',
  column: { type: 'UUID', primaryKey: true },
  phase: 'pre_foreign_key',
  mismatch: { expected: 'UUID', actual: 'text' },
  sql: 'ALTER TABLE "tags" ALTER COLUMN "id" TYPE uuid USING "id"::uuid',
  sqlStatements: [
    'ALTER TABLE "tags" ALTER COLUMN "id" TYPE uuid USING "id"::uuid',
  ],
};

const blocked: SchemaChangeLike = {
  type: 'type_upgrade',
  table: 'tags',
  name: 'id',
  column: { type: 'UUID', primaryKey: true },
  phase: 'pre_foreign_key',
  mismatch: { expected: 'UUID', actual: 'mixed uuid/text' },
  advisory: {
    severity: 'warning',
    message:
      'blocked: incompatible column types. The manifest declares UUID for tags.id, tags.parent_id, but tags.id holds 3 values that are not uuid-shaped.',
    suggestedSql: [
      'ALTER TABLE "tags" ALTER COLUMN "id" TYPE uuid USING "id"::uuid',
    ],
  },
};

describe('uuid convergence partitioning (#2608)', () => {
  it('keeps an executable conversion in the migration batch', () => {
    const result = partitionSchemaChanges([conversion], className);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]?.type).toBe('type_upgrade');
    expect(result.migrations[0]?.column?.name).toBe('id');
    expect(result.migrations[0]?.sqlStatements).toEqual(
      conversion.sqlStatements,
    );
    expect(result.manualInterventions).toHaveLength(0);
    expect(result.advisories).toHaveLength(0);
  });

  it('carries the pre_foreign_key phase onto the action', () => {
    // `db:migrate` builds its own tracker batch in `utilities.ts` and orders
    // it on this marker: conversions must precede every `create_table_*`
    // definition, because an acyclic new child table keeps its foreign key
    // inline in CREATE TABLE.
    const result = partitionSchemaChanges([conversion], className);
    expect(result.migrations[0]?.phase).toBe('pre_foreign_key');

    const ordinary = partitionSchemaChanges(
      [{ ...conversion, phase: undefined }],
      className,
    );
    expect(ordinary.migrations[0]?.phase).toBeUndefined();
  });

  it('reports a refused convergence as an advisory, not a manual migration', () => {
    const result = partitionSchemaChanges([blocked], className);
    expect(result.migrations).toHaveLength(0);
    expect(result.manualInterventions).toHaveLength(0);
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]?.type).toBe('type_upgrade');
    expect(result.advisories[0]?.tableName).toBe('tags');
    expect(result.advisories[0]?.name).toBe('id');
    expect(result.advisories[0]?.advisory.message).toContain('blocked:');
  });

  it('never turns a refused convergence into a tracker migration name', () => {
    expect([...getUnresolvedGeneratedMigrationNames([blocked])]).toEqual([]);
    expect(
      [...getUnresolvedGeneratedMigrationNames([conversion])].length,
    ).toBeGreaterThan(0);
  });

  it('prints the refusal with its manual repair', () => {
    const lines: string[] = [];
    printSchemaAdvisories(
      partitionSchemaChanges([blocked], className).advisories,
      { log: (line) => lines.push(line) },
    );
    const output = lines.join('\n');
    expect(output).toContain('tags.id: type upgrade blocked');
    expect(output).toContain('mixed uuid/text');
    expect(output).toContain('TYPE uuid USING');
  });
});
