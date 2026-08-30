import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  renderForeignKeyOrphanDetector,
  renderForeignKeyOrphanRepair,
} from './foreign-key-ddl.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
const contents = `i2551_contents_${suffix}`;
const parents = `i2551_parents_${suffix}`;
const children = `i2551_children_${suffix}`;
const textParents = `i2551_text_parents_${suffix}`;
const textChildren = `i2551_text_children_${suffix}`;

describe.skipIf(!pgUrl)('PostgreSQL foreign-key orphan probes (#2551)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2551-${randomUUID()}`,
      max: 2,
    } as Parameters<typeof getDatabase>[0]);
    await db.query(
      `CREATE TABLE "${contents}" (id UUID PRIMARY KEY, source_content_id UUID)`,
    );
    await db.query(`CREATE TABLE "${parents}" (id UUID PRIMARY KEY)`);
    await db.query(
      `CREATE TABLE "${children}" (id UUID PRIMARY KEY, parent_id TEXT)`,
    );
    await db.query(`CREATE TABLE "${textParents}" (id TEXT PRIMARY KEY)`);
    await db.query(
      `CREATE TABLE "${textChildren}" (id TEXT PRIMARY KEY, parent_id TEXT)`,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP TABLE IF EXISTS "${textChildren}"`);
    await db.query(`DROP TABLE IF EXISTS "${textParents}"`);
    await db.query(`DROP TABLE IF EXISTS "${children}"`);
    await db.query(`DROP TABLE IF EXISTS "${parents}"`);
    await db.query(`DROP TABLE IF EXISTS "${contents}"`);
    await db.close?.();
  });

  it('uses distinct aliases for self-references and detects a missing target', async () => {
    const foreignKey = {
      column: 'source_content_id',
      referencesTable: contents,
      referencesColumn: 'id',
    };
    const existingId = randomUUID();
    const missingId = randomUUID();
    await db.query(
      `INSERT INTO "${contents}" (id, source_content_id) VALUES ($1, $2)`,
      [existingId, existingId],
    );
    await db.query(
      `INSERT INTO "${contents}" (id, source_content_id) VALUES ($1, $2)`,
      [randomUUID(), missingId],
    );

    const detector = renderForeignKeyOrphanDetector(contents, foreignKey, {
      uuidComparison: true,
    });
    expect(detector).toContain('AS "smrt_fk_child"');
    expect(detector).toContain('AS "smrt_fk_parent"');

    const result = await db.query(detector);
    expect(result.rows).toEqual([{ orphan_key: missingId }]);
  });

  it('accepts canonical UUID text when the child column is a legacy text FK', async () => {
    const foreignKey = {
      column: 'parent_id',
      referencesTable: parents,
      referencesColumn: 'id',
    };
    const parentId = randomUUID();
    await db.query(`INSERT INTO "${parents}" (id) VALUES ($1)`, [parentId]);
    await db.query(
      `INSERT INTO "${children}" (id, parent_id) VALUES ($1, $2)`,
      [randomUUID(), parentId],
    );

    const detector = renderForeignKeyOrphanDetector(children, foreignKey, {
      uuidComparison: true,
    });
    expect(detector).toContain('::text ~*');
    expect(detector).toContain('::uuid');
    expect((await db.query(detector)).rows).toEqual([]);
  });

  it('keeps non-UUID text foreign keys as a direct comparison', async () => {
    const foreignKey = {
      column: 'parent_id',
      referencesTable: textParents,
      referencesColumn: 'id',
    };
    await db.query(`INSERT INTO "${textParents}" (id) VALUES ($1)`, [
      'parent-text-key',
    ]);
    await db.query(
      `INSERT INTO "${textChildren}" (id, parent_id) VALUES ($1, $2)`,
      ['child-text-key', 'parent-text-key'],
    );

    const detector = renderForeignKeyOrphanDetector(textChildren, foreignKey);
    expect(detector).not.toContain('::uuid');
    expect((await db.query(detector)).rows).toEqual([]);
  });

  it('reports malformed legacy text without crashing and clears only its FK in the suggested repair', async () => {
    const foreignKey = {
      column: 'parent_id',
      referencesTable: parents,
      referencesColumn: 'id',
    };
    const childId = randomUUID();
    await db.query(
      `INSERT INTO "${children}" (id, parent_id) VALUES ($1, $2)`,
      [childId, 'not-a-uuid'],
    );

    const detector = renderForeignKeyOrphanDetector(children, foreignKey, {
      uuidComparison: true,
    });
    expect((await db.query(detector)).rows).toEqual([
      { orphan_key: 'not-a-uuid' },
    ]);

    const repair = renderForeignKeyOrphanRepair(children, foreignKey, {
      uuidComparison: true,
    });
    expect(repair).toContain(`UPDATE "${children}" AS "smrt_fk_child"`);
    expect(repair).not.toContain('DELETE');
    await db.query(repair);

    const repaired = await db.query(
      `SELECT id, parent_id FROM "${children}" WHERE id = $1`,
      [childId],
    );
    expect(repaired.rows).toEqual([{ id: childId, parent_id: null }]);
  });
});
