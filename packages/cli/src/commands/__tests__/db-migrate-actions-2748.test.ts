import { describe, expect, it } from 'vitest';
import {
  type MigrationAction,
  orphanCountSql,
  partitionSchemaChanges,
  planOrphanDispositions,
} from '../db-migrate-actions.js';

describe('planOrphanDispositions', () => {
  const detectorSql =
    'SELECT "smrt_fk_child"."author_id" AS orphan_key FROM "posts" AS "smrt_fk_child" LEFT JOIN "authors" AS "smrt_fk_parent" ON "smrt_fk_parent"."id" = "smrt_fk_child"."author_id" WHERE "smrt_fk_child"."author_id" IS NOT NULL AND "smrt_fk_parent"."id" IS NULL';
  const repairSql =
    'UPDATE "posts" AS "smrt_fk_child" SET "author_id" = NULL WHERE "smrt_fk_child"."author_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "authors" AS "smrt_fk_parent" WHERE "smrt_fk_parent"."id" = "smrt_fk_child"."author_id")';

  it('plans a nullable orphan-blocked FK for disposition', () => {
    const action: MigrationAction = {
      type: 'add_foreign_key',
      tableName: 'posts',
      className: 'Post',
      orphanBlocked: true,
      orphanNullable: true,
      foreignKey: {
        column: 'author_id',
        referencesTable: 'authors',
        referencesColumn: 'id',
      },
      advisory: {
        severity: 'warning',
        message: 'Cannot add foreign key posts.author_id: ...',
        suggestedSql: [detectorSql, repairSql],
      },
    };

    const { nullable, notNullable } = planOrphanDispositions([action]);

    expect(notNullable).toEqual([]);
    expect(nullable).toEqual([
      {
        action,
        tableName: 'posts',
        column: 'author_id',
        detectorSql,
        repairSql,
      },
    ]);
  });

  it('refuses a NOT NULL child column unconditionally', () => {
    const action: MigrationAction = {
      type: 'add_foreign_key',
      tableName: 'posts',
      className: 'Post',
      orphanBlocked: true,
      orphanNullable: false,
      foreignKey: {
        column: 'author_id',
        referencesTable: 'authors',
        referencesColumn: 'id',
      },
      advisory: {
        severity: 'warning',
        message: 'Cannot add foreign key posts.author_id: ...',
        suggestedSql: [
          detectorSql,
          '-- Manual repair required: "posts"."author_id" is NOT NULL. ...',
        ],
      },
    };

    const { nullable, notNullable } = planOrphanDispositions([action]);

    expect(nullable).toEqual([]);
    expect(notNullable).toEqual([action]);
  });

  it('ignores manual interventions that are not orphan-blocked FKs', () => {
    const action: MigrationAction = {
      type: 'type_mismatch',
      tableName: 'contents',
      className: 'Content',
      mismatch: {
        column: 'published_at',
        expected: 'TIMESTAMP',
        actual: 'TEXT',
      },
    };

    const { nullable, notNullable } = planOrphanDispositions([action]);
    expect(nullable).toEqual([]);
    expect(notNullable).toEqual([]);
  });

  it('fails closed when a nullable orphan-blocked FK is missing its foreign key definition', () => {
    const action: MigrationAction = {
      type: 'add_foreign_key',
      tableName: 'posts',
      className: 'Post',
      orphanBlocked: true,
      orphanNullable: true,
      advisory: {
        severity: 'warning',
        message: 'Cannot add foreign key posts.author_id: ...',
        suggestedSql: [detectorSql, repairSql],
      },
    };

    const { nullable, notNullable } = planOrphanDispositions([action]);
    expect(nullable).toEqual([]);
    expect(notNullable).toEqual([action]);
  });

  it('fails closed when suggestedSql is missing the repair statement', () => {
    const action: MigrationAction = {
      type: 'add_foreign_key',
      tableName: 'posts',
      className: 'Post',
      orphanBlocked: true,
      orphanNullable: true,
      foreignKey: {
        column: 'author_id',
        referencesTable: 'authors',
        referencesColumn: 'id',
      },
      advisory: {
        severity: 'warning',
        message: 'Cannot add foreign key posts.author_id: ...',
        suggestedSql: [detectorSql],
      },
    };

    const { nullable, notNullable } = planOrphanDispositions([action]);
    expect(nullable).toEqual([]);
    expect(notNullable).toEqual([action]);
  });
});

describe('orphanCountSql', () => {
  it('wraps the detector SELECT as a COUNT(*) subquery', () => {
    const sql = orphanCountSql('SELECT 1 AS orphan_key FROM t');
    expect(sql).toBe(
      'SELECT COUNT(*) AS orphan_count FROM (SELECT 1 AS orphan_key FROM t) AS smrt_orphan_probe',
    );
  });
});

describe('partitionSchemaChanges propagates FK orphan metadata (#2748)', () => {
  it('carries foreignKey, orphanBlocked, and orphanNullable onto the manual-intervention action', () => {
    const { manualInterventions } = partitionSchemaChanges(
      [
        {
          type: 'add_foreign_key',
          table: 'posts',
          name: 'posts_author_id_authors_id_fkey',
          foreignKey: {
            column: 'author_id',
            referencesTable: 'authors',
            referencesColumn: 'id',
          },
          orphanBlocked: true,
          orphanNullable: true,
          advisory: {
            severity: 'warning',
            message: 'Cannot add foreign key posts.author_id: ...',
            suggestedSql: ['SELECT ...', 'UPDATE ...'],
          },
        },
      ],
      (tableName) => `${tableName}:Class`,
      'sqlite',
    );

    expect(manualInterventions).toHaveLength(1);
    expect(manualInterventions[0]).toMatchObject({
      type: 'add_foreign_key',
      tableName: 'posts',
      orphanBlocked: true,
      orphanNullable: true,
      foreignKey: {
        column: 'author_id',
        referencesTable: 'authors',
        referencesColumn: 'id',
      },
    });
  });

  it('carries foreignKey onto an executable add_foreign_key action', () => {
    const { migrations } = partitionSchemaChanges(
      [
        {
          type: 'add_foreign_key',
          table: 'posts',
          name: 'posts_author_id_authors_id_fkey',
          foreignKey: {
            column: 'author_id',
            referencesTable: 'authors',
            referencesColumn: 'id',
          },
          sqlStatements: ['ALTER TABLE "posts" ADD CONSTRAINT ...'],
        },
      ],
      (tableName) => `${tableName}:Class`,
      'sqlite',
    );

    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.foreignKey).toEqual({
      column: 'author_id',
      referencesTable: 'authors',
      referencesColumn: 'id',
    });
    expect(migrations[0]?.orphanBlocked).toBeUndefined();
  });
});
