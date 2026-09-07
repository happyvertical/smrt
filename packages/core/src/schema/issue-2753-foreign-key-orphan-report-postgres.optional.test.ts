/**
 * Per-foreign-key orphan count report (#2753) against a real PostgreSQL
 * database. The SQLite-backed unit tests in `foreign-key-orphan-report.test.ts`
 * cover the count/nullable/skip contract; this file exists so the same
 * probe's UUID-cast behavior (#2551) is exercised on the engine where it
 * actually matters.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectForeignKeyOrphanCounts } from './foreign-key-orphan-report.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
const parents = `i2753_parents_${suffix}`;
const children = `i2753_children_${suffix}`;
const requiredChildren = `i2753_required_children_${suffix}`;

describe.skipIf(!pgUrl)(
  'collectForeignKeyOrphanCounts against PostgreSQL (#2753)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2753-${randomUUID()}`,
        max: 2,
      } as Parameters<typeof getDatabase>[0]);
      await db.query(`CREATE TABLE "${parents}" (id UUID PRIMARY KEY)`);
      await db.query(
        `CREATE TABLE "${children}" (id UUID PRIMARY KEY, parent_id UUID)`,
      );
      await db.query(
        `CREATE TABLE "${requiredChildren}" (id UUID PRIMARY KEY, parent_id UUID NOT NULL)`,
      );
    });

    afterAll(async () => {
      if (!db) return;
      await db.query(`DROP TABLE IF EXISTS "${requiredChildren}"`);
      await db.query(`DROP TABLE IF EXISTS "${children}"`);
      await db.query(`DROP TABLE IF EXISTS "${parents}"`);
      await db.close?.();
    });

    function manifest(): Record<string, SchemaDefinition> {
      return {
        [parents]: {
          tableName: parents,
          columns: { id: { type: 'UUID', primaryKey: true } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
        [children]: {
          tableName: children,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            parent_id: {
              type: 'UUID',
              foreignKey: { table: parents, column: 'id' },
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
        [requiredChildren]: {
          tableName: requiredChildren,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            parent_id: {
              type: 'UUID',
              notNull: true,
              foreignKey: { table: parents, column: 'id' },
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };
    }

    it('counts UUID-column orphans and marks NOT NULL vs nullable', async () => {
      const parentId = randomUUID();
      await db.query(`INSERT INTO "${parents}" (id) VALUES ($1)`, [parentId]);
      await db.query(
        `INSERT INTO "${children}" (id, parent_id) VALUES ($1, $2), ($3, $4), ($5, NULL)`,
        [randomUUID(), parentId, randomUUID(), randomUUID(), randomUUID()],
      );
      await db.query(
        `INSERT INTO "${requiredChildren}" (id, parent_id) VALUES ($1, $2), ($3, $4)`,
        [randomUUID(), parentId, randomUUID(), randomUUID()],
      );

      const report = await collectForeignKeyOrphanCounts(db, manifest(), {
        engineHint: 'postgres',
      });

      expect(report.engine).toBe('postgres');
      const childCount = report.counts.find((c) => c.childTable === children);
      const requiredCount = report.counts.find(
        (c) => c.childTable === requiredChildren,
      );

      expect(childCount).toMatchObject({ orphanCount: 1, nullable: true });
      expect(requiredCount).toMatchObject({
        orphanCount: 1,
        nullable: false,
      });
      expect(report.skipped).toEqual([]);
    });
  },
);
