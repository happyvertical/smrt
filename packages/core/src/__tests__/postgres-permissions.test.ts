import { describe, expect, it } from 'vitest';
import { validatePostgresPermissionContract } from '../postgres-permissions.js';

const valid = {
  schema: 'app',
  schemaExclusive: true,
  migrationOwner: 'owner',
  runtimeRole: 'runtime',
  managedTables: ['items'],
};

describe('PostgreSQL permission configuration', () => {
  it('validates and copies a canonical contract including quoted identifiers', () => {
    expect(
      validatePostgresPermissionContract({
        ...valid,
        managedTables: ['odd"name', 'items', 'items'],
      }).managedTables,
    ).toEqual(['items', 'odd"name']);
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
    { ...valid, monitor: { role: 'monitor', tables: { items: [] } } },
    {
      ...valid,
      monitor: { role: 'monitor', tables: { items: ['id'] }, typo: true },
    },
  ])('rejects malformed or unsupported configuration %#', (input) => {
    expect(() => validatePostgresPermissionContract(input)).toThrow();
  });
});
