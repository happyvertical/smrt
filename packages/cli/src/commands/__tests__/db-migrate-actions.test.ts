import { describe, expect, it } from 'vitest';
import { partitionSchemaChanges } from '../db-migrate-actions.js';

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
