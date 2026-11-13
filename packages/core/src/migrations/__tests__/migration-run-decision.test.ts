import { describe, expect, it } from 'vitest';
import type { DatabaseEngine } from '../../schema/ddl/types.js';
import type { SchemaChangeInput } from '../change-kinds.js';
import { decideMigrationRun } from '../migration-run-decision.js';

const stop: SchemaChangeInput = {
  type: 'alter_column',
  table: 'posts',
  name: 'title',
  alteration: 'set_not_null',
  kindHint: 'column.required-nulls',
  advisory: {
    severity: 'warning',
    message: 'Repair NULLs first.',
    suggestedSql: ['UPDATE posts SET title = ...'],
  },
};
const add: SchemaChangeInput = {
  type: 'add_column',
  table: 'posts',
  name: 'note',
  sql: 'ALTER TABLE posts ADD COLUMN note TEXT',
};

describe('decideMigrationRun (#4927)', () => {
  it.each<DatabaseEngine>([
    'sqlite',
    'postgres',
    'duckdb',
    'json',
  ])('one stop holds every apply change and new table on %s', (engine) => {
    const result = decideMigrationRun({
      engine,
      addedTables: [{ tableName: 'tags' }],
      changes: [
        stop,
        add,
        { type: 'add_table', table: 'tags' },
        {
          type: 'add_index',
          table: 'posts',
          name: 'posts_note_idx',
          sql: 'CREATE INDEX posts_note_idx ON posts(note)',
        },
      ],
    });
    expect(result.proceed).toBe(false);
    expect(result.stops).toEqual([
      {
        change: stop,
        kind: 'column.required-nulls',
        reason: 'invents-data',
        message: expect.stringContaining('posts.title: would invent data'),
      },
    ]);
    expect(result.heldBack).toEqual([
      { table: 'tags', description: 'Create table tags' },
      { table: 'posts', column: 'note', description: 'Add column posts.note' },
      { table: 'posts', description: 'Add index posts.posts_note_idx' },
    ]);
  });
  it('report-only diffs, including warnings, proceed', () => {
    expect(
      decideMigrationRun({
        engine: 'sqlite',
        changes: [
          {
            type: 'orphan_column',
            table: 'posts',
            name: 'legacy',
            advisory: {
              severity: 'warning',
              message: 'Legacy NOT NULL column.',
            },
          },
          { type: 'orphan_index', table: 'posts', name: 'legacy_unique' },
        ],
      }),
    ).toEqual({
      proceed: true,
      releaseStop: null,
      stops: [],
      packageStops: [],
      notices: [],
      heldBack: [],
    });
  });
  it('executable and empty plans proceed with no held-back changes', () => {
    for (const changes of [[], [add]])
      expect(decideMigrationRun({ engine: 'sqlite', changes })).toEqual({
        proceed: true,
        releaseStop: null,
        stops: [],
        packageStops: [],
        notices: [],
        heldBack: [],
      });
  });
  it('unknown changes and declared unsupported shapes remain stops', () => {
    const result = decideMigrationRun({
      engine: 'duckdb',
      changes: [
        { type: 'future_change', table: 'posts', name: 'note' },
        {
          type: 'add_foreign_key',
          table: 'posts',
          name: 'parent_id',
          engineUnsupported: true,
        },
      ],
    });
    expect(result.proceed).toBe(false);
    expect(result.stops.map((s) => s.reason)).toEqual([
      'unlisted',
      'unresolved-non-data-stop',
    ]);
  });
  it('an explicitly resolved stop proceeds, but a second stop holds its planned FK too', () => {
    const orphan: SchemaChangeInput = {
      type: 'add_foreign_key',
      table: 'posts',
      orphanBlocked: true,
      foreignKey: {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
    };
    const resolvedStops = new Set([orphan]);
    expect(
      decideMigrationRun({
        engine: 'postgres',
        changes: [orphan, add],
        resolvedStops,
      }).proceed,
    ).toBe(true);
    const refused = decideMigrationRun({
      engine: 'postgres',
      changes: [orphan, stop, add],
      resolvedStops,
    });
    expect(refused.stops.map((s) => s.change)).toEqual([stop]);
    expect(refused.heldBack).toContainEqual({
      table: 'posts',
      column: 'parent_id',
      description: 'Add foreign key posts.parent_id',
    });
    // The exemption must reference the exact original change.
    expect(
      decideMigrationRun({
        engine: 'postgres',
        changes: [{ ...orphan }],
        resolvedStops,
      }).proceed,
    ).toBe(false);
  });
});
