import { describe, expect, it } from 'vitest';
import type { DatabaseEngine } from '../../schema/ddl/types.js';
import type { SchemaChangeInput } from '../change-kinds.js';
import {
  decideMigrationRun,
  describeAppMigrationRefusal,
  describeMigrationRefusal,
  formatMigrationRefusal,
} from '../migration-run-decision.js';

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

describe('describeMigrationRefusal (#4927)', () => {
  it('says what stopped and what was held back; the CLI and the local runtime share it', () => {
    const decision = decideMigrationRun({
      changes: [
        {
          type: 'alter_column',
          table: 'notes',
          name: 'title',
          alteration: 'set_not_null',
          advisory: {
            severity: 'warning',
            message: 'notes.title holds NULL',
            suggestedSql: ['UPDATE notes SET title = <value>'],
          },
        } as SchemaChangeInput,
        {
          type: 'add_column',
          table: 'other',
          name: 'extra',
          sql: 'ALTER TABLE other ADD COLUMN extra TEXT',
        },
      ],
      addedTables: [{ tableName: 'fresh' }],
      engine: 'sqlite',
    });
    const text = describeMigrationRefusal(decision, { repairSql: true });
    expect(text.headline).toContain('would lose or invent data');
    expect(text.stopLines.join('\n')).toContain('notes.title');
    expect(text.stopLines.join('\n')).toContain('UPDATE notes SET title');
    expect(text.heldBackLines.join('\n')).toContain('Create table fresh');
    expect(text.heldBackLines.join('\n')).toContain('other.extra');
    const plain = formatMigrationRefusal(decision);
    expect(plain).toContain(text.headline);
    expect(plain).toContain(text.heldBackHeading);
    expect(plain).not.toContain('UPDATE notes SET title');
  });
});

describe('describeAppMigrationRefusal (#4928, an app that migrates itself)', () => {
  const removed = decideMigrationRun({
    changes: [],
    engine: 'sqlite',
    packagesSeen: {
      recorded: ['@app/a', '@scope/b'],
      current: ['@app/a'],
      confirmedRemoved: [],
    },
  });
  const unloaded = decideMigrationRun({
    changes: [],
    engine: 'sqlite',
    packagesSeen: {
      recorded: ['@app/a'],
      current: ['@app/a'],
      confirmedRemoved: [],
      build: {
        planned: 'x',
        unloaded: [{ packageName: '@scope/c', tables: ['c_things'] }],
      },
    },
  });
  const release = decideMigrationRun({
    changes: [],
    engine: 'sqlite',
    recordedRelease: '0.0.1',
  });

  it('keeps the user line free of commands and options, for every stop', () => {
    for (const decision of [removed, unloaded, release]) {
      const { userLine } = describeAppMigrationRefusal(decision);
      expect(userLine).toContain('nothing was changed');
      expect(userLine).toContain("app's developer");
      expect(userLine).not.toMatch(/smrt|db:migrate|--|confirmRemoved|option/);
    }
  });

  it('tells the developer the option for a removed package, never the CLI flag', () => {
    const { developerLines } = describeAppMigrationRefusal(removed);
    const text = developerLines.join('\n');
    expect(text).toContain('@scope/b');
    expect(text).toContain('"@scope/b" to the confirmRemovedPackages option');
    expect(text).not.toContain('--confirm-removed-package');
    expect(text).not.toContain('db:migrate');
  });

  it('says plainly that no option clears an unloaded package or a release stop', () => {
    expect(
      describeAppMigrationRefusal(unloaded).developerLines.join('\n'),
    ).toMatch(/c_things.*does not clear this: ship a build that loads them/);
    expect(
      describeAppMigrationRefusal(release).developerLines.join('\n'),
    ).toMatch(
      /No app option skips this: ship a build of the app made with smrt/,
    );
  });

  it('leaves the CLI wording as it was', () => {
    expect(formatMigrationRefusal(removed)).toContain(
      'Load the package, or pass --confirm-removed-package @scope/b to confirm its removal.',
    );
    expect(formatMigrationRefusal(unloaded)).toContain(
      "Load every model before migrating, or run smrt db:migrate in the app's project.",
    );
    expect(formatMigrationRefusal(release)).toContain(
      "then run this build's migrate again.",
    );
  });
});
