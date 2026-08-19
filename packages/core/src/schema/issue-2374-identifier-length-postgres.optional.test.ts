/**
 * Issue #2374 — the 63-byte identifier limit, against a live PostgreSQL.
 *
 * Runs only in the PostgreSQL lane (`pnpm --filter @happyvertical/smrt-core
 * test:postgres`, which supplies `DATABASE_URL`); skipped otherwise.
 *
 * This is the one bug in the epic that **cannot** be reproduced on SQLite or
 * DuckDB: neither has an identifier limit, so both store a 99-byte index name
 * verbatim and every unit test passes against a schema PostgreSQL would never
 * have created. The unit coverage in `index-utils.test.ts` proves the guard
 * computes the right name; only a real server proves the three facts that
 * motivated it:
 *
 * 1. an over-long name is silently TRUNCATED — no error, no warning, and
 *    `pg_indexes` reports a name the manifest does not contain, so the
 *    migration differ can never match it by name again;
 * 2. two names that agree for 63 bytes are ONE identifier — the second
 *    `CREATE INDEX IF NOT EXISTS` no-ops and that index is simply absent;
 * 3. the guarded names round-trip exactly, and a database still holding the
 *    old truncated name migrates by name swap with no rebuild.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import type { DatabaseInterface } from '../migrations/types.js';
import { SchemaGenerator } from './generator.js';
import {
  identifierByteLength,
  MAX_IDENTIFIER_BYTES,
  shortenIdentifier,
} from './index-utils.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;

/**
 * A table name long enough that the generated conflict index overflows — the
 * shape that shipped as the 66-byte
 * `content_contribution_revisions_contribution_id_revision_number_idx`.
 */
const TABLE = `i2374_contribution_revisions_${suffix}`;

/**
 * `@happyvertical/sql` returns `{ rows, rowCount }` on PostgreSQL but a bare
 * array on other engines; normalize so the assertions read the same either way.
 */
function resultRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

describe.skipIf(!pgUrl)('identifier length guard on PostgreSQL (#2374)', () => {
  let db: DatabaseInterface;
  let schema: SchemaDefinition;
  /** The generated conflict index, post-guard. */
  let conflictIndexName: string;
  /** What the generator WOULD have emitted before the guard. */
  const unguardedName = `${TABLE}_contribution_id_revision_number_idx`;

  async function indexNames(): Promise<string[]> {
    const rows = resultRows<{ indexname: string }>(
      await db.query('SELECT indexname FROM pg_indexes WHERE tablename = $1', [
        TABLE,
      ]),
    );
    return rows.map((row) => row.indexname).sort();
  }

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2374-${randomUUID()}`,
      max: 2,
    } as Parameters<typeof getDatabase>[0])) as unknown as DatabaseInterface;

    // Build from the PRODUCTION schema path, not by hand: the point is that
    // what `smrt db:migrate` ships is what PostgreSQL can actually store.
    const generator = new SchemaGenerator();
    const manifestSchema = generator.generateCTISchemaFromManifest(
      'ContributionRevision',
      TABLE,
      {
        contributionId: { type: 'text', required: true },
        revisionNumber: { type: 'integer', default: 0 },
      },
      {
        idType: 'text',
        conflictColumns: ['contribution_id', 'revision_number'],
      },
    );

    const conflict = manifestSchema.indexes.find((index) => index.unique);
    if (!conflict) {
      throw new Error(
        `generator emitted no unique conflict index: ${JSON.stringify(
          manifestSchema.indexes.map((i) => i.name),
        )}`,
      );
    }
    conflictIndexName = conflict.name;

    schema = {
      tableName: TABLE,
      ddl: manifestSchema.ddl,
      columns: Object.fromEntries(
        Object.entries(manifestSchema.columns).map(([name, column]) => [
          name,
          {
            type: column.type as SchemaDefinition['columns'][string]['type'],
            primaryKey: column.primaryKey,
            notNull: column.notNull,
            unique: column.unique,
          },
        ]),
      ),
      indexes: manifestSchema.indexes.map((index) => ({
        name: index.name,
        columns: index.columns,
        unique: index.unique,
        where: index.where,
        jsonPath: index.jsonPath,
      })),
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: manifestSchema.version,
    };

    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await db.query(schema.ddl);
  }, 120_000);

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await (db as unknown as { close?: () => Promise<void> })?.close?.();
    }
  });

  it('the unguarded name really does overflow, and the guard really does change it', () => {
    expect(identifierByteLength(unguardedName)).toBeGreaterThan(
      MAX_IDENTIFIER_BYTES,
    );
    expect(conflictIndexName).toBe(shortenIdentifier(unguardedName));
    expect(identifierByteLength(conflictIndexName)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
  });

  it('PostgreSQL silently truncates an over-long name, so pg_indexes no longer matches the manifest', async () => {
    // No error and no warning — this is the whole problem.
    await db.query(
      `CREATE INDEX "${unguardedName}" ON "${TABLE}" (contribution_id)`,
    );
    const stored = await indexNames();

    expect(stored).not.toContain(unguardedName);
    expect(stored).toContain(unguardedName.slice(0, MAX_IDENTIFIER_BYTES));

    await db.query(
      `DROP INDEX "${unguardedName.slice(0, MAX_IDENTIFIER_BYTES)}"`,
    );
  });

  it('collapses two unguarded names that agree for 63 bytes into one index', async () => {
    // Same first 63 bytes, different tails. To PostgreSQL these are the same
    // identifier, so the second CREATE ... IF NOT EXISTS is a no-op and that
    // index is simply never created — while the differ keeps reporting it
    // missing, forever.
    const shared = `${TABLE}_shared_prefix_padding_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const first = `${shared}_contribution_id_idx`;
    const second = `${shared}_revision_number_idx`;
    expect(first.slice(0, MAX_IDENTIFIER_BYTES)).toBe(
      second.slice(0, MAX_IDENTIFIER_BYTES),
    );

    const before = await indexNames();
    await db.query(
      `CREATE INDEX IF NOT EXISTS "${first}" ON "${TABLE}" (contribution_id)`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "${second}" ON "${TABLE}" (revision_number)`,
    );
    const afterUnguarded = await indexNames();
    expect(afterUnguarded.length - before.length).toBe(1);

    // The surviving index is on the FIRST statement's column: the second
    // index — the one someone asked for — does not exist at all.
    const truncated = first.slice(0, MAX_IDENTIFIER_BYTES);
    const columns = resultRows<{ indexdef: string }>(
      await db.query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [
        truncated,
      ]),
    );
    expect(columns[0]?.indexdef).toContain('contribution_id');
    expect(columns[0]?.indexdef).not.toContain('revision_number');
    await db.query(`DROP INDEX "${truncated}"`);

    // Guarded, the same two names are distinct and both indexes exist.
    const guardedFirst = shortenIdentifier(first);
    const guardedSecond = shortenIdentifier(second);
    expect(guardedFirst).not.toBe(guardedSecond);
    await db.query(
      `CREATE INDEX IF NOT EXISTS "${guardedFirst}" ON "${TABLE}" (contribution_id)`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "${guardedSecond}" ON "${TABLE}" (revision_number)`,
    );
    const afterGuarded = await indexNames();
    expect(afterGuarded.length - before.length).toBe(2);
    expect(afterGuarded).toContain(guardedFirst);
    expect(afterGuarded).toContain(guardedSecond);

    await db.query(`DROP INDEX "${guardedFirst}"`);
    await db.query(`DROP INDEX "${guardedSecond}"`);
  });

  it('stores every generated index under exactly the name the manifest carries', async () => {
    for (const index of schema.indexes) {
      await db.query(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX "${index.name}" ON "${TABLE}" (${index.columns
          .map((column) => `"${column}"`)
          .join(', ')})`,
      );
    }

    const stored = await indexNames();
    for (const index of schema.indexes) {
      expect(stored, `index ${index.name} round-trips`).toContain(index.name);
    }
  });

  it('finds no drift for the guarded schema against the live database', async () => {
    // Indexes were created by the previous test from this same schema.
    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare({ [TABLE]: schema });

    expect(
      diff.changes.filter(
        (change) =>
          change.table === TABLE &&
          (change.type === 'add_index' || change.type === 'drop_index'),
      ),
    ).toEqual([]);
  });

  it('migrates a legacy truncated index by name swap, without rebuilding it', async () => {
    // Reproduce a pre-guard deployment: drop the guarded conflict index and
    // recreate it under the name PostgreSQL truncated the old one to.
    const legacyName = unguardedName.slice(0, MAX_IDENTIFIER_BYTES);
    await db.query(`DROP INDEX "${conflictIndexName}"`);
    await db.query(
      `CREATE UNIQUE INDEX "${legacyName}" ON "${TABLE}" (contribution_id, revision_number)`,
    );

    const comparer = new SchemaComparer(db, { includeDroppedIndexes: true });
    const diff = await comparer.compare({ [TABLE]: schema });

    // The differ claims it by signature — columns plus uniqueness plus
    // predicate — so an existing deployment neither rebuilds the index nor
    // loses the UNIQUE constraint its UPSERT conflict target binds to.
    expect(
      diff.changes.filter(
        (change) =>
          change.table === TABLE &&
          (change.type === 'add_index' || change.type === 'drop_index'),
      ),
    ).toEqual([]);
    expect(await indexNames()).toContain(legacyName);
  });
});
