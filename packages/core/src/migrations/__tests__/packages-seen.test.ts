import { describe, expect, it } from 'vitest';
import {
  checkPackagesSeen,
  decideMigrationRun,
} from '../migration-run-decision.js';

const current = ['@app/shop', '<unqualified>'];
describe('packages seen (#4928)', () => {
  it.each([
    {
      label: 'no record',
      recorded: null,
      current,
      confirmedRemoved: [],
      state: 'no-record',
      missing: [],
      unconfirmed: [],
      ignoredConfirmations: [],
    },
    {
      label: 'all present',
      recorded: current,
      current,
      confirmedRemoved: [],
      state: 'ok',
      missing: [],
      unconfirmed: [],
      ignoredConfirmations: [],
    },
    {
      label: 'missing',
      recorded: [...current, '@scope/b'],
      current,
      confirmedRemoved: [],
      state: 'missing',
      missing: ['@scope/b'],
      unconfirmed: ['@scope/b'],
      ignoredConfirmations: [],
    },
    {
      label: 'added only',
      recorded: ['@app/shop'],
      current,
      confirmedRemoved: [],
      state: 'ok',
      missing: [],
      unconfirmed: [],
      ignoredConfirmations: [],
    },
    {
      label: 'confirmed',
      recorded: [...current, '@scope/b'],
      current,
      confirmedRemoved: ['@scope/b'],
      state: 'ok',
      missing: ['@scope/b'],
      unconfirmed: [],
      ignoredConfirmations: [],
    },
    {
      label: 'partial confirmation',
      recorded: [...current, '@scope/c', '@scope/b'],
      current,
      confirmedRemoved: ['@scope/b'],
      state: 'missing',
      missing: ['@scope/b', '@scope/c'],
      unconfirmed: ['@scope/c'],
      ignoredConfirmations: [],
    },
    {
      label: 'non-missing name',
      recorded: current,
      current,
      confirmedRemoved: ['@app/shop', 'other'],
      state: 'ok',
      missing: [],
      unconfirmed: [],
      ignoredConfirmations: ['@app/shop', 'other'],
    },
    {
      label: 'exact names',
      recorded: ['<unqualified>', '@scope/B'],
      current: [],
      confirmedRemoved: ['unqualified', '@scope/b'],
      state: 'missing',
      missing: ['<unqualified>', '@scope/B'],
      unconfirmed: ['<unqualified>', '@scope/B'],
      ignoredConfirmations: ['@scope/b', 'unqualified'],
    },
    {
      label: 'duplicates',
      recorded: ['b', 'b'],
      current: [],
      confirmedRemoved: ['b', 'b', 'a', 'a'],
      state: 'ok',
      missing: ['b'],
      unconfirmed: [],
      ignoredConfirmations: ['a'],
    },
    {
      label: 'confirmation without record',
      recorded: null,
      current,
      confirmedRemoved: ['@scope/b'],
      state: 'no-record',
      missing: [],
      unconfirmed: [],
      ignoredConfirmations: ['@scope/b'],
    },
  ])('$label', ({
    label: _label,
    state,
    missing,
    unconfirmed,
    ignoredConfirmations,
    ...input
  }) => {
    expect(checkPackagesSeen(input)).toEqual({
      state,
      missing,
      unconfirmed,
      ignoredConfirmations,
    });
  });

  it.each([
    'sqlite',
    'postgres',
    'duckdb',
    'json',
  ] as const)('package stops hold every apply change on %s', (engine) => {
    const result = decideMigrationRun({
      engine,
      addedTables: [{ tableName: 'tags' }],
      changes: [
        {
          type: 'add_column',
          table: 'posts',
          name: 'note',
          sql: 'ALTER TABLE posts ADD COLUMN note TEXT',
        },
      ],
      packagesSeen: {
        recorded: ['@scope/b'],
        current: [],
        confirmedRemoved: [],
      },
    });
    expect(result.proceed).toBe(false);
    expect(result.stops).toEqual([]);
    expect(result.packageStops).toEqual([
      {
        packageName: '@scope/b',
        kind: 'removed',
        message: expect.stringContaining('--confirm-removed-package @scope/b'),
      },
    ]);
    expect(result.packageStops[0].message).toContain('could loosen');
    expect(result.heldBack.map((item) => item.description)).toEqual([
      'Create table tags',
      'Add column posts.note',
    ]);
  });
  it('confirming a package never clears a schema stop', () => {
    const result = decideMigrationRun({
      engine: 'sqlite',
      changes: [
        {
          type: 'alter_column',
          table: 'posts',
          name: 'history',
          alteration: 'set_not_null',
          kindHint: 'column.required-nulls',
          advisory: { severity: 'warning', message: 'Repair NULLs first.' },
        },
      ],
      packagesSeen: {
        recorded: ['@scope/b'],
        current: [],
        confirmedRemoved: ['@scope/b'],
      },
    });
    expect(result.proceed).toBe(false);
    expect(result.packageStops).toEqual([]);
    expect(result.stops).toHaveLength(1);
  });
});
