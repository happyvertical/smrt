import { describe, expect, it } from 'vitest';
import {
  computeBlockedColumns,
  filterUnresolvedOrphanDispositions,
  type MigrationAction,
  orphanCountSql,
  partitionSchemaChanges,
  partitionUnblockedMigrations,
  planOrphanDispositions,
  type SchemaAdvisory,
  type WithheldMigration,
} from '../db-migrate-actions.js';

/**
 * #2748: `db:migrate --apply-unblocked` and `--null-orphans`.
 *
 * Reframed scope per the issue's "Reframed after measurement" comment:
 * withholding one blocked change (an FK with orphan rows, a blocked type
 * upgrade) should not withhold unrelated safe DDL in the same batch when the
 * operator opts in. A change that genuinely depends on a blocked column
 * (an index or FK on that column) still stays withheld.
 */
describe('computeBlockedColumns', () => {
  it('keys a blocked column by table.column from a type_mismatch', () => {
    const manualInterventions: MigrationAction[] = [
      {
        type: 'type_mismatch',
        tableName: 'contents',
        className: 'Content',
        mismatch: {
          column: 'published_at',
          expected: 'TIMESTAMP',
          actual: 'TEXT',
        },
      },
    ];

    const blocked = computeBlockedColumns(manualInterventions);
    expect(blocked.get('contents.published_at')).toBe(
      'expected TIMESTAMP, found TEXT',
    );
  });

  it('keys a blocked column from an orphan-blocked add_foreign_key by its child column', () => {
    const manualInterventions: MigrationAction[] = [
      {
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
          message:
            'Cannot add foreign key posts.author_id: existing rows do not match authors.id. Repair them, then rerun.',
        },
      },
    ];

    const blocked = computeBlockedColumns(manualInterventions);
    expect(blocked.has('posts.author_id')).toBe(true);
    expect(blocked.get('posts.author_id')).toContain('Cannot add foreign key');
  });

  it('ignores an engine-unsupported add_foreign_key (SQLite/DuckDB cannot express the constraint at all)', () => {
    // Real differ shape (packages/core/src/migrations/differ.ts, the
    // non-postgres branch): `foreignKey` IS populated here, same as every
    // other add_foreign_key advisory. Only `engineUnsupported: true`
    // distinguishes "this engine can never add this constraint" from a
    // column-state block (review finding, #2748) — a prior version of this
    // test fabricated a foreignKey-less shape the differ never produces and
    // passed without exercising the real gate.
    const manualInterventions: MigrationAction[] = [
      {
        type: 'add_foreign_key',
        tableName: 'posts',
        className: 'Post',
        engineUnsupported: true,
        foreignKey: {
          column: 'author_id',
          referencesTable: 'authors',
          referencesColumn: 'id',
        },
        advisory: {
          severity: 'warning',
          message:
            'SQLite requires a table rebuild to add a foreign key to an existing table.',
        },
      },
    ];

    expect(computeBlockedColumns(manualInterventions).size).toBe(0);
  });

  it('still blocks a same-shape add_foreign_key that is not engine-unsupported (conflicting constraint / type block)', () => {
    const manualInterventions: MigrationAction[] = [
      {
        type: 'add_foreign_key',
        tableName: 'posts',
        className: 'Post',
        foreignKey: {
          column: 'author_id',
          referencesTable: 'authors',
          referencesColumn: 'id',
        },
        advisory: {
          severity: 'warning',
          message:
            'Foreign key posts.author_id exists with a different target or action.',
        },
      },
    ];

    const blocked = computeBlockedColumns(manualInterventions);
    expect(blocked.has('posts.author_id')).toBe(true);
  });

  it('blocks a column named only by a report-only type_upgrade advisory', () => {
    // #2608 refused uuid convergence never enters `manualInterventions` (it
    // carries no SQL), but it names a live column just as concretely --
    // `--apply-unblocked` must not apply an index/alter/drop against that
    // column either (review finding, #2748).
    const blocked = computeBlockedColumns(
      [],
      [
        {
          type: 'type_upgrade',
          tableName: 'posts',
          className: 'Post',
          name: 'author_id',
          advisory: {
            severity: 'warning',
            message: 'blocked: incompatible column types.',
          },
        },
      ],
    );

    expect(blocked.get('posts.author_id')).toContain(
      'incompatible column types',
    );
  });

  it('does not block a column named only by an un-opted-into relaxation alter_column advisory', () => {
    // Real differ shape (differ.ts buildAlterColumnChange): a live default
    // or NOT NULL the manifest no longer declares, reported as an
    // advisory-only alter_column only because `--relax-columns` was not
    // passed -- not because the column's own state blocks anything. Every
    // rerun without that flag reproduces the same advisory, so treating it
    // as a blocked column would permanently withhold unrelated executable
    // DDL on that column, the same defect the `engineUnsupported` exclusion
    // fixes for `add_foreign_key` (review finding, #2748, second pass).
    const blocked = computeBlockedColumns(
      [],
      [
        {
          type: 'alter_column',
          tableName: 'posts',
          className: 'Post',
          name: 'published_at',
          alteration: 'drop_not_null',
          advisory: {
            severity: 'warning',
            message:
              'posts.published_at is NOT NULL in the database but nullable in the manifest.',
          },
        },
      ],
    );

    expect(blocked.size).toBe(0);
  });
});

describe('partitionUnblockedMigrations', () => {
  it('applies an index on an unrelated table even when another table is blocked', () => {
    const migrations: MigrationAction[] = [
      {
        type: 'add_index',
        tableName: 'orders',
        className: 'Order',
        index: { name: 'orders_status_idx', columns: ['status'] },
        sql: 'CREATE INDEX "orders_status_idx" ON "orders" ("status")',
      },
    ];
    const blocked = new Map([['contents.published_at', 'blocked reason']]);

    const { applied, withheld } = partitionUnblockedMigrations(
      migrations,
      blocked,
    );

    expect(applied).toEqual(migrations);
    expect(withheld).toEqual([]);
  });

  it('withholds an index on a column whose type upgrade is blocked', () => {
    const migrations: MigrationAction[] = [
      {
        type: 'add_index',
        tableName: 'contents',
        className: 'Content',
        index: { name: 'contents_published_at_idx', columns: ['published_at'] },
        sql: 'CREATE INDEX "contents_published_at_idx" ON "contents" ("published_at")',
      },
    ];
    const blocked = new Map([
      ['contents.published_at', 'expected TIMESTAMP, found TEXT'],
    ]);

    const { applied, withheld } = partitionUnblockedMigrations(
      migrations,
      blocked,
    );

    expect(applied).toEqual([]);
    expect(withheld).toEqual([
      {
        action: migrations[0],
        dependsOn: 'contents.published_at',
        reason: 'expected TIMESTAMP, found TEXT',
      },
    ]);
  });

  it('withholds a foreign key whose parent column is blocked, not only its child column', () => {
    const migrations: MigrationAction[] = [
      {
        type: 'add_foreign_key',
        tableName: 'posts',
        className: 'Post',
        foreignKey: {
          column: 'author_id',
          referencesTable: 'authors',
          referencesColumn: 'id',
        },
        sqlStatements: ['ALTER TABLE "posts" ADD CONSTRAINT ...'],
      },
    ];
    const blocked = new Map([['authors.id', 'blocked type upgrade']]);

    const { applied, withheld } = partitionUnblockedMigrations(
      migrations,
      blocked,
    );

    expect(applied).toEqual([]);
    expect(withheld[0]?.dependsOn).toBe('authors.id');
  });

  it('applies a new column add even when the table has an unrelated blocked column', () => {
    const migrations: MigrationAction[] = [
      {
        type: 'add_column',
        tableName: 'contents',
        className: 'Content',
        column: { name: 'slug', type: 'TEXT' },
        sql: 'ALTER TABLE "contents" ADD COLUMN "slug" TEXT',
      },
    ];
    const blocked = new Map([
      ['contents.published_at', 'expected TIMESTAMP, found TEXT'],
    ]);

    const { applied, withheld } = partitionUnblockedMigrations(
      migrations,
      blocked,
    );

    expect(applied).toEqual(migrations);
    expect(withheld).toEqual([]);
  });

  it('preserves input order across the applied/withheld split', () => {
    const safe: MigrationAction = {
      type: 'add_index',
      tableName: 'orders',
      className: 'Order',
      index: { name: 'orders_status_idx', columns: ['status'] },
    };
    const dependent: MigrationAction = {
      type: 'add_index',
      tableName: 'contents',
      className: 'Content',
      index: { name: 'contents_published_at_idx', columns: ['published_at'] },
    };
    const blocked = new Map([['contents.published_at', 'reason']]);

    const { applied, withheld } = partitionUnblockedMigrations(
      [dependent, safe],
      blocked,
    );

    expect(applied).toEqual([safe]);
    expect(withheld.map((w) => w.action)).toEqual([dependent]);
  });

  it('withholds a shape-drift drop_index paired with a withheld add_index of the same name (review, #2748)', () => {
    // #1165 shape-drift repair order: drop_index then add_index for the
    // same name. If the add is withheld (its columns include a blocked
    // one) but the drop is not, applying the drop alone removes the
    // existing index/uniqueness enforcement with no replacement.
    const drop: MigrationAction = {
      type: 'drop_index',
      tableName: 'contents',
      className: 'Content',
      indexName: 'contents_published_at_idx',
    };
    const add: MigrationAction = {
      type: 'add_index',
      tableName: 'contents',
      className: 'Content',
      index: {
        name: 'contents_published_at_idx',
        columns: ['published_at'],
        unique: true,
      },
    };
    const blocked = new Map([
      ['contents.published_at', 'expected TIMESTAMP, found TEXT'],
    ]);

    const { applied, withheld } = partitionUnblockedMigrations(
      [drop, add],
      blocked,
    );

    expect(applied).toEqual([]);
    expect(withheld.map((w) => w.action)).toEqual([drop, add]);
    expect(withheld[0]?.reason).toContain(
      'paired with the withheld rebuild of index contents_published_at_idx',
    );
  });

  it('applies a lone orphan-index drop_index with no paired add_index', () => {
    const drop: MigrationAction = {
      type: 'drop_index',
      tableName: 'contents',
      className: 'Content',
      indexName: 'contents_stale_idx',
    };
    const blocked = new Map([
      ['contents.published_at', 'expected TIMESTAMP, found TEXT'],
    ]);

    const { applied, withheld } = partitionUnblockedMigrations([drop], blocked);

    expect(applied).toEqual([drop]);
    expect(withheld).toEqual([]);
  });

  it('applies a drop_index whose paired add_index was not withheld', () => {
    const drop: MigrationAction = {
      type: 'drop_index',
      tableName: 'orders',
      className: 'Order',
      indexName: 'orders_status_idx',
    };
    const add: MigrationAction = {
      type: 'add_index',
      tableName: 'orders',
      className: 'Order',
      index: { name: 'orders_status_idx', columns: ['status'], unique: true },
    };
    const blocked = new Map([
      ['contents.published_at', 'expected TIMESTAMP, found TEXT'],
    ]);

    const { applied, withheld } = partitionUnblockedMigrations(
      [drop, add],
      blocked,
    );

    expect(applied).toEqual([drop, add]);
    expect(withheld).toEqual([]);
  });
});

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

describe('filterUnresolvedOrphanDispositions', () => {
  // Final review finding, #2748: a --null-orphans combined null+add-FK
  // migration can itself depend on a separately blocked *parent* column and
  // get withheld under --apply-unblocked even though it already resolved
  // out of `manualInterventions`. The post-apply report must not print a
  // resolution for a disposition whose migration never ran.
  const combinedAction: MigrationAction = {
    type: 'add_foreign_key',
    tableName: 'posts',
    className: 'Post',
    foreignKey: {
      column: 'author_id',
      referencesTable: 'authors',
      referencesColumn: 'id',
    },
    sqlStatements: ['UPDATE ...', 'ALTER TABLE "posts" ADD CONSTRAINT ...'],
  };

  it('keeps a pending disposition whose migration was not withheld', () => {
    const pending = [
      { tableName: 'posts', column: 'author_id', action: combinedAction },
    ];

    expect(filterUnresolvedOrphanDispositions(pending, [])).toEqual(pending);
  });

  it('returns a fresh array, not the input reference, on the nothing-withheld path', () => {
    // Recall finding, #2748: the caller (utilities.ts) replaces its source
    // array in place via `arr.length = 0; arr.push(...result)`. If `result`
    // were the same reference as the input, `.length = 0` would truncate it
    // out from under itself before the spread, silently dropping every
    // pending disposition on the common success path -- exactly the
    // regression this test pins.
    const pending = [
      { tableName: 'posts', column: 'author_id', action: combinedAction },
    ];

    const result = filterUnresolvedOrphanDispositions(pending, []);
    expect(result).not.toBe(pending);

    pending.length = 0;
    pending.push(...result);
    expect(pending).toHaveLength(1);
  });

  it('drops a pending disposition whose migration was withheld (blocked parent column)', () => {
    const pending = [
      { tableName: 'posts', column: 'author_id', action: combinedAction },
    ];
    const withheld: WithheldMigration[] = [
      {
        action: combinedAction,
        dependsOn: 'authors.id',
        reason: 'blocked: incompatible column types.',
      },
    ];

    expect(filterUnresolvedOrphanDispositions(pending, withheld)).toEqual([]);
  });

  it('only drops the matching entry, by action identity, when several are pending', () => {
    const otherAction: MigrationAction = {
      type: 'add_foreign_key',
      tableName: 'comments',
      className: 'Comment',
      foreignKey: {
        column: 'post_id',
        referencesTable: 'posts',
        referencesColumn: 'id',
      },
      sqlStatements: [
        'UPDATE ...',
        'ALTER TABLE "comments" ADD CONSTRAINT ...',
      ],
    };
    const pending = [
      { tableName: 'posts', column: 'author_id', action: combinedAction },
      { tableName: 'comments', column: 'post_id', action: otherAction },
    ];
    const withheld: WithheldMigration[] = [
      {
        action: combinedAction,
        dependsOn: 'authors.id',
        reason: 'blocked: incompatible column types.',
      },
    ];

    expect(filterUnresolvedOrphanDispositions(pending, withheld)).toEqual([
      pending[1],
    ]);
  });
});
