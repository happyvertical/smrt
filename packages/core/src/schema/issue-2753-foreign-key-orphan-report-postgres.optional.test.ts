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
const legacyTextParents = `i2753_legacy_text_parents_${suffix}`;
const legacyTextChildren = `i2753_legacy_text_children_${suffix}`;
const mixedChildren = `i2753_mixed_children_${suffix}`;

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
      // #2608-tolerated legacy component: manifest declares UUID on both
      // sides, but the live columns are still `text` on every side (neither
      // has converged). The review-cycle #2753 finding is that a naive
      // manifest-only cast decision guard-casts the child to `::uuid` here,
      // producing `text = uuid` against the still-text parent.
      await db.query(
        `CREATE TABLE "${legacyTextParents}" (id TEXT PRIMARY KEY)`,
      );
      await db.query(
        `CREATE TABLE "${legacyTextChildren}" (id TEXT PRIMARY KEY, parent_id TEXT)`,
      );
      // Mixed live types: child is legacy text, parent already converged to
      // native uuid — the cast must guard the child side, not the parent.
      await db.query(
        `CREATE TABLE "${mixedChildren}" (id UUID PRIMARY KEY, parent_id TEXT)`,
      );
    });

    afterAll(async () => {
      if (!db) return;
      await db.query(`DROP TABLE IF EXISTS "${mixedChildren}"`);
      await db.query(`DROP TABLE IF EXISTS "${legacyTextChildren}"`);
      await db.query(`DROP TABLE IF EXISTS "${legacyTextParents}"`);
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
        // The manifest declares UUID on both sides for both of these — the
        // live columns are what actually differ (text/text, then text/uuid).
        [legacyTextParents]: {
          tableName: legacyTextParents,
          columns: { id: { type: 'UUID', primaryKey: true } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
        [legacyTextChildren]: {
          tableName: legacyTextChildren,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            parent_id: {
              type: 'UUID',
              foreignKey: { table: legacyTextParents, column: 'id' },
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
        [mixedChildren]: {
          tableName: mixedChildren,
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

    it('counts a legacy text/text relationship directly, without a text=uuid cast (#2753 review finding)', async () => {
      const parentId = 'legacy-parent-key';
      await db.query(`INSERT INTO "${legacyTextParents}" (id) VALUES ($1)`, [
        parentId,
      ]);
      await db.query(
        `INSERT INTO "${legacyTextChildren}" (id, parent_id) VALUES ($1, $2), ($3, $4)`,
        ['child-1', parentId, 'child-2', 'missing-legacy-parent'],
      );

      const report = await collectForeignKeyOrphanCounts(db, manifest(), {
        engineHint: 'postgres',
      });

      const count = report.counts.find(
        (c) => c.childTable === legacyTextChildren,
      );
      expect(count).toMatchObject({ orphanCount: 1, nullable: true });
      expect(
        report.skipped.some((s) => s.childTable === legacyTextChildren),
      ).toBe(false);
    });

    it('casts only the legacy-text side of a mixed uuid/text relationship (#2753 review finding)', async () => {
      // `mixedChildren.parent_id` is live TEXT; it references `parents.id`,
      // which is live native UUID — the cast must guard the child (text)
      // side, matching a self-standing parent row inserted here so the test
      // does not depend on another test's insert order.
      const parentId = randomUUID();
      await db.query(`INSERT INTO "${parents}" (id) VALUES ($1)`, [parentId]);
      const goodChildId = randomUUID();
      const orphanChildId = randomUUID();
      await db.query(
        `INSERT INTO "${mixedChildren}" (id, parent_id) VALUES ($1, $2), ($3, $4)`,
        [goodChildId, parentId, orphanChildId, randomUUID()],
      );

      const report = await collectForeignKeyOrphanCounts(db, manifest(), {
        engineHint: 'postgres',
      });

      const count = report.counts.find((c) => c.childTable === mixedChildren);
      expect(count).toMatchObject({ orphanCount: 1, nullable: true });
      expect(report.skipped.some((s) => s.childTable === mixedChildren)).toBe(
        false,
      );
    });
  },
);
