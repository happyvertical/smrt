import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type applyPostgresPermissions,
  type planPostgresPermissions,
  validatePostgresPermissionContract,
} from '../postgres-permissions.js';

const valid = {
  schema: 'app',
  schemaExclusive: true,
  migrationOwner: 'owner',
  runtimeRole: 'runtime',
  managedTables: ['items'],
  managedTriggerFunctions: [],
};

describe('PostgreSQL permission configuration', () => {
  it('keeps the exported planner and apply contract compatible without trigger declarations', () => {
    const legacyContract = {
      schema: 'app',
      schemaExclusive: true,
      migrationOwner: 'owner',
      runtimeRole: 'runtime',
      managedTables: ['items'],
    } as const;
    expectTypeOf(legacyContract).toMatchTypeOf<
      Parameters<typeof planPostgresPermissions>[1]
    >();
    expectTypeOf(legacyContract).toMatchTypeOf<
      Parameters<typeof applyPostgresPermissions>[1]
    >();
  });
  it('validates and copies a canonical contract including quoted identifiers', () => {
    expect(
      validatePostgresPermissionContract({
        ...valid,
        managedTables: ['odd"name', 'items', 'items'],
      }).managedTables,
    ).toEqual(['items', 'odd"name']);
    expect(
      validatePostgresPermissionContract({
        ...valid,
        retainedTables: ['audit', 'audit', 'odd"history'],
      }).retainedTables,
    ).toEqual(['audit', 'odd"history']);
  });
  it.each([
    null,
    { ...valid, automatic: true },
    { ...valid, schemaExclusive: false },
    { ...valid, schema: 'pg_catalog' },
    { ...valid, runtimeRole: 'owner' },
    { ...valid, runtimeRole: 'PUBLIC' },
    { ...valid, runtimeRole: 'a\0b' },
    { ...valid, runtimeRole: 'x'.repeat(64) },
    { ...valid, managedTables: 'items' },
    { ...valid, retainedTables: 'items' },
    { ...valid, retainedTables: ['items'] },
    { ...valid, managedTriggerFunctions: 'guard' },
    { ...valid, monitor: { role: 'monitor', tables: { items: [] } } },
    {
      ...valid,
      monitor: { role: 'monitor', tables: { items: ['id'] }, typo: true },
    },
  ])('rejects malformed or unsupported configuration %#', (input) => {
    expect(() => validatePostgresPermissionContract(input)).toThrow();
  });
});
