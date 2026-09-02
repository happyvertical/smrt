/**
 * #2608 against a live PostgreSQL server.
 *
 * The mocked differ tests prove the plan; these prove the plan is the one
 * PostgreSQL actually accepts — that `ADD CONSTRAINT` really does fail with
 * SQLSTATE 42804 across uuid/text, that the guard refuses before that
 * happens, and that applying the planned conversions makes the same
 * constraint apply cleanly.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { collectStatementsFromDiff } from '../migrations/orchestrate.js';
import { SchemaManager } from './schema-manager.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
const tags = `i2608_tags_${suffix}`;
const folders = `i2608_folders_${suffix}`;
const assets = `i2608_assets_${suffix}`;

function manifest(
  tableName: string,
  references: Record<string, { table: string }> = {},
): SchemaDefinition {
  const columns: SchemaDefinition['columns'] = {
    id: { type: 'UUID', primaryKey: true },
  };
  for (const [column, target] of Object.entries(references)) {
    columns[column] = {
      type: 'UUID',
      foreignKey: {
        table: target.table,
        column: 'id',
        onDelete: 'NO ACTION',
        onUpdate: 'CASCADE',
      },
    };
  }
  return {
    tableName,
    columns,
    indexes: [],
    triggers: [],
    foreignKeys: Object.entries(references).map(([column, target]) => ({
      column,
      referencesTable: target.table,
      referencesColumn: 'id',
      onDelete: 'NO ACTION' as const,
      onUpdate: 'CASCADE' as const,
    })),
    dependencies: Object.values(references).map((target) => target.table),
    version: '2608',
  };
}

describe.skipIf(!pgUrl)('PostgreSQL uuid convergence (#2608)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2608-${randomUUID()}`,
      max: 2,
    } as Parameters<typeof getDatabase>[0]);
    // A pre-R11 shape: text ids, uuid references added afterwards.
    await db.query(
      `CREATE TABLE "${tags}" (id TEXT PRIMARY KEY, parent_id UUID)`,
    );
    await db.query(`CREATE TABLE "${folders}" (id UUID PRIMARY KEY)`);
    await db.query(
      `CREATE TABLE "${assets}" (id TEXT PRIMARY KEY, folder_id TEXT)`,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP TABLE IF EXISTS "${assets}"`);
    await db.query(`DROP TABLE IF EXISTS "${folders}"`);
    await db.query(`DROP TABLE IF EXISTS "${tags}"`);
    await db.close?.();
  });

  it('reproduces SQLSTATE 42804 for the DDL the guard now refuses', async () => {
    await expect(
      db.query(
        `ALTER TABLE "${tags}" ADD CONSTRAINT "${tags}_probe_fkey" FOREIGN KEY ("parent_id") REFERENCES "${tags}" ("id") NOT VALID`,
      ),
    ).rejects.toThrow(/42804|incompatible types/i);
  });

  it('refuses the constraint instead of letting PostgreSQL abort the batch', async () => {
    const manager = new SchemaManager(db, { engine: 'postgres' });
    await expect(
      manager.ensurePostgresForeignKey(
        tags,
        {
          column: 'parent_id',
          referencesTable: tags,
          referencesColumn: 'id',
          onDelete: 'NO ACTION',
          onUpdate: 'CASCADE',
        },
        { nullable: true, uuidComparison: true },
      ),
    ).rejects.toThrow(/incompatible column types.*SQLSTATE 42804/s);
  });

  it('converges the columns, after which the same foreign keys apply', async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    const folderId = randomUUID();
    await db.query(`INSERT INTO "${tags}" (id, parent_id) VALUES ($1, NULL)`, [
      parentId,
    ]);
    await db.query(`INSERT INTO "${tags}" (id, parent_id) VALUES ($1, $2)`, [
      childId,
      parentId,
    ]);
    await db.query(`INSERT INTO "${folders}" (id) VALUES ($1)`, [folderId]);
    await db.query(`INSERT INTO "${assets}" (id, folder_id) VALUES ($1, $2)`, [
      randomUUID(),
      folderId,
    ]);

    const schemas = {
      [tags]: manifest(tags, { parent_id: { table: tags } }),
      [folders]: manifest(folders),
      [assets]: manifest(assets, { folder_id: { table: folders } }),
    };

    const diff = await new SchemaComparer(db, {
      engineHint: 'postgres',
    }).compare(schemas);
    const statements = getSQLFromDiff(diff);
    const lastConversion = statements.findLastIndex((statement) =>
      statement.includes('TYPE uuid USING'),
    );
    const firstForeignKey = statements.findIndex((statement) =>
      statement.includes('ADD CONSTRAINT'),
    );
    expect(lastConversion).toBeGreaterThanOrEqual(0);
    expect(firstForeignKey).toBeGreaterThan(lastConversion);

    for (const statement of statements) {
      await db.query(statement);
    }

    const types = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ($1, $2)
       ORDER BY table_name, column_name`,
      [tags, assets],
    );
    const byColumn = Object.fromEntries(
      (
        types.rows as {
          table_name: string;
          column_name: string;
          data_type: string;
        }[]
      ).map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );
    expect(byColumn[`${tags}.id`]).toBe('uuid');
    expect(byColumn[`${tags}.parent_id`]).toBe('uuid');
    expect(byColumn[`${assets}.folder_id`]).toBe('uuid');
    // Convergence is relationship-driven: nothing references `assets.id`, so
    // the R11 text tolerance leaves it alone.
    expect(byColumn[`${assets}.id`]).toBe('text');

    // The data survived and the constraints are live and validated.
    const rows = await db.query(
      `SELECT id, parent_id FROM "${tags}" WHERE id = $1`,
      [childId],
    );
    expect((rows.rows as { parent_id: string }[])[0]?.parent_id).toBe(parentId);

    await expect(
      db.query(`INSERT INTO "${tags}" (id, parent_id) VALUES ($1, $2)`, [
        randomUUID(),
        randomUUID(),
      ]),
    ).rejects.toThrow();

    // Idempotent: a second pass finds nothing left to converge.
    const after = await new SchemaComparer(db, {
      engineHint: 'postgres',
    }).compare(schemas);
    expect(
      getSQLFromDiff(after).filter((statement) =>
        statement.includes('TYPE uuid USING'),
      ),
    ).toEqual([]);
  });

  it('creates a new uuid child table against a converged legacy text parent', async () => {
    // The new child is acyclic, so its foreign key stays **inline in CREATE
    // TABLE**: if the parent has not converged by then, PostgreSQL rejects
    // the statement with SQLSTATE 42804 and takes the batch with it.
    const legacyParents = `i2608_new_parents_${suffix}`;
    const newChildren = `i2608_new_children_${suffix}`;
    await db.query(`CREATE TABLE "${legacyParents}" (id TEXT PRIMARY KEY)`);
    const parentId = randomUUID();
    await db.query(`INSERT INTO "${legacyParents}" (id) VALUES ($1)`, [
      parentId,
    ]);
    try {
      const schemas = {
        [legacyParents]: manifest(legacyParents),
        [newChildren]: manifest(newChildren, {
          parent_id: { table: legacyParents },
        }),
      };
      const diff = await new SchemaComparer(db, {
        engineHint: 'postgres',
      }).compare(schemas);
      const statements = collectStatementsFromDiff(diff, db, 'postgres');
      for (const statement of statements) {
        await db.query(statement);
      }

      const types = await db.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1
           AND column_name = 'id'`,
        [legacyParents],
      );
      expect((types.rows as { data_type: string }[])[0]?.data_type).toBe(
        'uuid',
      );
      // The inline constraint really is live on the new child.
      await db.query(
        `INSERT INTO "${newChildren}" (id, parent_id) VALUES ($1, $2)`,
        [randomUUID(), parentId],
      );
      await expect(
        db.query(
          `INSERT INTO "${newChildren}" (id, parent_id) VALUES ($1, $2)`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow();
    } finally {
      await db.query(`DROP TABLE IF EXISTS "${newChildren}"`);
      await db.query(`DROP TABLE IF EXISTS "${legacyParents}"`);
    }
  });

  it('blocks when a table outside the manifest still references a converging column', async () => {
    const orphanParents = `i2608_orphan_parents_${suffix}`;
    const orphanChildren = `i2608_orphan_children_${suffix}`;
    const legacyLinks = `i2608_orphan_links_${suffix}`;
    await db.query(`CREATE TABLE "${orphanParents}" (id TEXT PRIMARY KEY)`);
    await db.query(
      `CREATE TABLE "${orphanChildren}" (id UUID PRIMARY KEY, parent_id UUID)`,
    );
    // Not in the manifest, but PostgreSQL still refuses to rewrite the column
    // this constraint depends on.
    await db.query(
      `CREATE TABLE "${legacyLinks}" (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES "${orphanParents}" ("id"))`,
    );
    try {
      const schemas = {
        [orphanParents]: manifest(orphanParents),
        [orphanChildren]: manifest(orphanChildren, {
          parent_id: { table: orphanParents },
        }),
      };
      const diff = await new SchemaComparer(db, {
        engineHint: 'postgres',
      }).compare(schemas);

      expect(
        getSQLFromDiff(diff).filter((statement) =>
          statement.includes('TYPE uuid USING'),
        ),
      ).toEqual([]);
      expect(
        diff.changes.some((change) =>
          change.advisory?.message.includes('live foreign keys still depend'),
        ),
      ).toBe(true);

      // And the ALTER the planner refused really is the one PostgreSQL rejects.
      await expect(
        db.query(
          `ALTER TABLE "${orphanParents}" ALTER COLUMN "id" TYPE uuid USING "id"::uuid`,
        ),
      ).rejects.toThrow();
    } finally {
      await db.query(`DROP TABLE IF EXISTS "${legacyLinks}"`);
      await db.query(`DROP TABLE IF EXISTS "${orphanChildren}"`);
      await db.query(`DROP TABLE IF EXISTS "${orphanParents}"`);
    }
  });

  it('refuses to coerce a value that is not uuid-shaped', async () => {
    const dirtyParents = `i2608_dirty_parents_${suffix}`;
    const dirtyChildren = `i2608_dirty_children_${suffix}`;
    await db.query(`CREATE TABLE "${dirtyParents}" (id TEXT PRIMARY KEY)`);
    await db.query(
      `CREATE TABLE "${dirtyChildren}" (id UUID PRIMARY KEY, parent_id UUID)`,
    );
    await db.query(`INSERT INTO "${dirtyParents}" (id) VALUES ('root')`);
    try {
      const schemas = {
        [dirtyParents]: manifest(dirtyParents),
        [dirtyChildren]: manifest(dirtyChildren, {
          parent_id: { table: dirtyParents },
        }),
      };
      const diff = await new SchemaComparer(db, {
        engineHint: 'postgres',
      }).compare(schemas);

      expect(getSQLFromDiff(diff)).toEqual([]);
      expect(
        diff.changes.some((change) =>
          change.advisory?.message.includes('not uuid-shaped'),
        ),
      ).toBe(true);
      expect(
        diff.changes.some((change) =>
          change.advisory?.message.includes(
            'blocked: incompatible column types',
          ),
        ),
      ).toBe(true);
    } finally {
      await db.query(`DROP TABLE IF EXISTS "${dirtyChildren}"`);
      await db.query(`DROP TABLE IF EXISTS "${dirtyParents}"`);
    }
  });
});
