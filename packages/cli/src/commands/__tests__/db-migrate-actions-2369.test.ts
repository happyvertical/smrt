/**
 * Issue #2369 — CLI handling of the differ's `alter_column`, `drop_column`,
 * `orphan_column` and `orphan_index` changes: partitioning into executable /
 * manual / advisory, synthetic tracker ids, failure classification, and the
 * shared advisory printer.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyFailedMigration,
  getSyntheticMigrationNameForAction,
  getSyntheticMigrationNameForChange,
  getUnresolvedGeneratedMigrationNames,
  partitionSchemaChanges,
  printSchemaAdvisories,
  type SchemaChangeLike,
} from '../db-migrate-actions.js';
import { summarizeSchemaDiff } from '../db-status.js';

const className = (tableName: string) => `${tableName}:Class`;

const executableSetNotNull: SchemaChangeLike = {
  type: 'alter_column',
  table: 'items',
  name: 'status',
  column: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
  alteration: 'set_not_null',
  mismatch: { expected: 'NOT NULL', actual: 'NULL' },
  sql: 'ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL',
  sqlStatements: [
    `UPDATE "items" SET "status" = 'draft' WHERE "status" IS NULL`,
    'ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL',
  ],
};

const manualSqliteSetDefault: SchemaChangeLike = {
  type: 'alter_column',
  table: 'items',
  name: 'kind',
  column: { type: 'TEXT', defaultValue: 'b' },
  alteration: 'set_default',
  mismatch: { expected: "DEFAULT 'b'", actual: "DEFAULT 'a'" },
  sql: "-- SQLite: setting the default on kind requires table recreation (expected DEFAULT 'b', found DEFAULT 'a'; #2370)",
};

const advisoryDropNotNull: SchemaChangeLike = {
  type: 'alter_column',
  table: 'items',
  name: 'note',
  column: { type: 'TEXT' },
  alteration: 'drop_not_null',
  mismatch: { expected: 'NULL', actual: 'NOT NULL' },
  advisory: {
    severity: 'warning',
    message:
      'items.note is NOT NULL in the database but nullable in the manifest; writes that store NULL will fail. Pass relaxColumns / --relax-columns to drop the constraint.',
    suggestedSql: ['ALTER TABLE "items" ALTER COLUMN "note" DROP NOT NULL'],
  },
};

const orphanBlocking: SchemaChangeLike = {
  type: 'orphan_column',
  table: 'posts',
  name: 'title',
  mismatch: { expected: '(not in manifest)', actual: 'TEXT NOT NULL' },
  advisory: {
    severity: 'warning',
    message:
      'posts.title is NOT NULL without a default and is not in the manifest — every ORM insert into posts will fail (not-null violation). Pass relaxColumns / --relax-columns to drop the NOT NULL (keeps data), or includeDroppedColumns / --drop-columns to drop the column.',
    suggestedSql: [
      'ALTER TABLE "posts" ALTER COLUMN "title" DROP NOT NULL',
      'ALTER TABLE "posts" DROP COLUMN "title"',
    ],
  },
};

const orphanInfo: SchemaChangeLike = {
  type: 'orphan_column',
  table: 'posts',
  name: 'legacy',
  mismatch: { expected: '(not in manifest)', actual: 'TEXT' },
  advisory: {
    severity: 'info',
    message:
      'posts.legacy exists in the database but not in the manifest (TEXT).',
    suggestedSql: ['ALTER TABLE "posts" DROP COLUMN "legacy"'],
  },
};

const orphanUnique: SchemaChangeLike = {
  type: 'orphan_index',
  table: 'users',
  name: 'users_email_key',
  mismatch: { expected: '(not in manifest)', actual: 'UNIQUE (email)' },
  advisory: {
    severity: 'warning',
    message:
      'Unique constraint users_email_key on users(email) is no longer declared by the manifest; duplicate values the model now allows will still be rejected. Drop it manually.',
    suggestedSql: ['DROP INDEX IF EXISTS "users_email_key"'],
  },
};

const dropColumn: SchemaChangeLike = {
  type: 'drop_column',
  table: 'posts',
  name: 'title',
  mismatch: { expected: '(not in manifest)', actual: 'TEXT NOT NULL' },
  sql: 'ALTER TABLE "posts" DROP COLUMN "title"',
};

describe('partitionSchemaChanges (#2369)', () => {
  it('routes executable alterations to migrations, comment-only ones to manual, advisories to advisories', () => {
    const { migrations, manualInterventions, advisories } =
      partitionSchemaChanges(
        [
          executableSetNotNull,
          manualSqliteSetDefault,
          advisoryDropNotNull,
          orphanBlocking,
          orphanInfo,
          orphanUnique,
          dropColumn,
        ],
        className,
      );

    expect(migrations.map((m) => `${m.type}:${m.columnName}`)).toEqual([
      'alter_column:status',
      'drop_column:title',
    ]);
    expect(migrations[0]).toMatchObject({
      type: 'alter_column',
      tableName: 'items',
      className: 'items:Class',
      columnName: 'status',
      alteration: 'set_not_null',
      column: {
        name: 'status',
        type: 'TEXT',
        notNull: true,
        defaultValue: 'draft',
      },
      mismatch: { column: 'status', expected: 'NOT NULL', actual: 'NULL' },
      sqlStatements: executableSetNotNull.sqlStatements,
    });
    expect(migrations[1]).toMatchObject({
      type: 'drop_column',
      tableName: 'posts',
      columnName: 'title',
      sql: 'ALTER TABLE "posts" DROP COLUMN "title"',
    });

    expect(manualInterventions).toEqual([
      expect.objectContaining({
        type: 'alter_column',
        columnName: 'kind',
        alteration: 'set_default',
        mismatch: {
          column: 'kind',
          expected: "DEFAULT 'b'",
          actual: "DEFAULT 'a'",
        },
      }),
    ]);

    expect(
      advisories.map((a) => `${a.type}:${a.name}:${a.advisory.severity}`),
    ).toEqual([
      'alter_column:note:warning',
      'orphan_column:title:warning',
      'orphan_column:legacy:info',
      'orphan_index:users_email_key:warning',
    ]);
    expect(advisories[0]).toMatchObject({
      tableName: 'items',
      className: 'items:Class',
      alteration: 'drop_not_null',
      actual: 'NOT NULL',
    });
  });
});

describe('synthetic migration names (#2369)', () => {
  it('gives alter_column ids that embed the alteration and SQL shape, drop_column ids the column', () => {
    const alterName = getSyntheticMigrationNameForChange(executableSetNotNull);
    expect(alterName).toMatch(
      /^alter_column_items_status_set_not_null_[0-9a-f]{8}$/,
    );
    // A different alteration on the same column is a distinct tracker row.
    expect(
      getSyntheticMigrationNameForChange({
        ...executableSetNotNull,
        alteration: 'drop_not_null',
        sql: 'ALTER TABLE "items" ALTER COLUMN "status" DROP NOT NULL',
        sqlStatements: undefined,
      }),
    ).toMatch(/^alter_column_items_status_drop_not_null_[0-9a-f]{8}$/);
    expect(getSyntheticMigrationNameForChange(dropColumn)).toBe(
      'drop_column_posts_title',
    );
    // Report-only relaxations never get a tracker id.
    expect(getSyntheticMigrationNameForChange(advisoryDropNotNull)).toBeNull();
    expect(getSyntheticMigrationNameForChange(orphanBlocking)).toBeNull();

    // Action ↔ change ids agree so `--force-migration` targets resolve.
    const { migrations } = partitionSchemaChanges(
      [executableSetNotNull, dropColumn],
      className,
    );
    expect(getSyntheticMigrationNameForAction(migrations[0])).toBe(alterName);
    expect(getSyntheticMigrationNameForAction(migrations[1])).toBe(
      'drop_column_posts_title',
    );
  });

  it('classifies failed alter_column/drop_column rows against live drift like the other generated repairs', () => {
    const unresolved = getUnresolvedGeneratedMigrationNames([
      executableSetNotNull,
      manualSqliteSetDefault,
      advisoryDropNotNull,
      dropColumn,
    ]);
    const alterName = getSyntheticMigrationNameForChange(
      executableSetNotNull,
    ) as string;
    expect(unresolved.has(alterName)).toBe(true);
    expect(unresolved.has('drop_column_posts_title')).toBe(true);
    expect([...unresolved].some((n) => n.includes('_note_'))).toBe(false);
    expect(classifyFailedMigration(alterName, unresolved)).toBe('unresolved');
    expect(
      classifyFailedMigration(
        'alter_column_items_status_set_not_null_deadbeef',
        unresolved,
      ),
    ).toBe('superseded');
    expect(classifyFailedMigration('drop_column_posts_old', unresolved)).toBe(
      'superseded',
    );
  });
});

describe('db:status summarizeSchemaDiff (#2369)', () => {
  it('surfaces constraint drift, orphan columns and stale unique constraints as drift entries', () => {
    const drift = summarizeSchemaDiff({
      added_tables: [],
      changes: [
        executableSetNotNull,
        manualSqliteSetDefault,
        advisoryDropNotNull,
        orphanBlocking,
        orphanInfo,
        orphanUnique,
      ],
    });
    expect(drift.map((d) => `${d.name}:${d.type}`)).toEqual([
      'items.status:nullability_drift',
      'items.kind:default_drift',
      'items.note:nullability_drift',
      'posts.title:orphan_column_blocking',
      'posts.legacy:orphan_column',
      'users.users_email_key:orphan_unique_constraint',
    ]);
    expect(drift[0].recommendation).toMatch(/Run `smrt db:migrate` to repair/);
    expect(drift[1].recommendation).toMatch(/Manual intervention required/);
    expect(drift[2].recommendation).toMatch(/--relax-columns/);
    expect(drift[3].recommendation).toMatch(
      /every ORM insert into posts will fail/,
    );
  });
});

describe('printSchemaAdvisories (#2369)', () => {
  it('prints warnings with their remediation, info compactly, orphan tables only when verbose', () => {
    const { advisories } = partitionSchemaChanges(
      [advisoryDropNotNull, orphanBlocking, orphanInfo, orphanUnique],
      className,
    );
    const lines: string[] = [];
    printSchemaAdvisories(advisories, {
      orphanTables: ['zombie'],
      log: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    expect(text).toContain('need an operator decision');
    expect(text).toContain('posts.title: orphan column (TEXT NOT NULL)');
    expect(text).toContain(
      '↳ ALTER TABLE "posts" ALTER COLUMN "title" DROP NOT NULL',
    );
    expect(text).toContain(
      'users.users_email_key: unique constraint not in manifest',
    );
    expect(text).toContain('items.note: drop_not_null (live: NOT NULL)');
    expect(text).toContain('Live schema notes (1, not applied)');
    expect(text).toContain('posts.legacy: orphan column (TEXT)');
    expect(text).not.toContain('zombie');

    const verbose: string[] = [];
    printSchemaAdvisories(advisories, {
      orphanTables: ['zombie'],
      verbose: true,
      log: (line) => verbose.push(line),
    });
    expect(verbose.join('\n')).toContain(
      'no loaded manifest declares (1): zombie',
    );
  });

  it('prints nothing when there is nothing to report', () => {
    const lines: string[] = [];
    printSchemaAdvisories([], { log: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });
});
