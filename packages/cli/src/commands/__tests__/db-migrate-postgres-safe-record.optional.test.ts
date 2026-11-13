/**
 * #4927 evidence on real PostgreSQL for `smrt db:migrate --postgres-safe`, the
 * one declared exception to all-or-nothing migrate:
 *
 * 1. it sends `CREATE [UNIQUE] INDEX CONCURRENTLY` (never a plain CREATE INDEX)
 *    and the indexes exist and are valid afterwards;
 * 2. a failed concurrent build exits nonzero and writes no migrate record, so a
 *    production start is still refused;
 * 3. after the cause is removed a rerun rebuilds the INVALID index, writes the
 *    record, and the production startup check passes.
 *
 * The SQL is observed at the executor the command uses: the database handle,
 * its transactions and its pinned sessions are all wrapped to record statements.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import {
  assertDatabaseMigratedForBuild,
  collectMigrateRecordInput,
  MigrationTracker,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '@happyvertical/smrt-core/migrations';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { utilityCommands } from '../utilities.js';

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 2 },
    ],
    totalObjects: 2,
  })),
}));

/** Every statement the command's own database handle sends, in order. */
const sent: string[] = [];
let startSequence = 0;

function recording<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== 'function') return value;
      if (property === 'query') {
        return (sql: unknown, ...rest: unknown[]) => {
          if (typeof sql === 'string') sent.push(sql);
          return (value as (...args: unknown[]) => unknown).call(
            object,
            sql,
            ...rest,
          );
        };
      }
      if (property === 'acquireSession') {
        return async (...args: unknown[]) =>
          recording(
            (await (value as (...a: unknown[]) => unknown).apply(
              object,
              args,
            )) as object,
          );
      }
      if (property === 'transaction') {
        return (callback: (tx: object) => unknown, ...rest: unknown[]) =>
          (value as (...a: unknown[]) => unknown).call(
            object,
            (tx: object) => callback(recording(tx)),
            ...rest,
          );
      }
      return value.bind(object);
    },
  });
}

vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  let sequence = 0;
  return {
    ...actual,
    getDatabase: async (options: Parameters<typeof actual.getDatabase>[0]) =>
      recording(
        (await actual.getDatabase({
          ...options,
          dbid: `4927r-${process.pid}-${++sequence}`,
        })) as object,
      ) as Awaited<ReturnType<typeof actual.getDatabase>>,
  };
});

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

describe.skipIf(!pgUrl)(
  'db:migrate --postgres-safe: CONCURRENTLY, failure record, recovery (#4927, PostgreSQL)',
  () => {
    const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = `rec4927_${suffix}`;
    const created = `recnew4927_${suffix}`;
    const uniqueIndex = `${existing}_title_unique`;
    const plainIndex = `${existing}_note_idx`;
    const createdIndex = `${created}_label_idx`;
    let db: DatabaseInterface;
    let schemas: Record<string, SchemaDefinition>;
    let logs: ReturnType<typeof vi.spyOn>;
    let errors: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      sent.length = 0;
      db = await getDatabase({ type: 'postgres', url: pgUrl });
      await clearRecords();
      await db.query(
        `CREATE TABLE "${existing}" (id TEXT PRIMARY KEY, title TEXT)`,
      );
      await new MigrationTracker({ db }).initialize();
      schemas = {
        [existing]: {
          tableName: existing,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            title: { type: 'TEXT' },
            note: { type: 'TEXT' },
          },
          indexes: [
            { name: uniqueIndex, columns: ['title'], unique: true },
            { name: plainIndex, columns: ['note'] },
          ],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '4927',
        },
        [created]: {
          tableName: created,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            label: { type: 'TEXT' },
          },
          indexes: [{ name: createdIndex, columns: ['label'] }],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '4927',
        },
      };
      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'postgres', url: pgUrl } } },
      });
      vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
        () => schemas,
      );
      vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue(
        Object.keys(schemas),
      );
      vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
        (name: string) => name,
      );
      logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.exitCode = undefined;
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      await clearRecords();
      await db.query(`DROP TABLE IF EXISTS "${created}" CASCADE`);
      await db.query(`DROP TABLE IF EXISTS "${existing}" CASCADE`);
      await db.close?.();
      clearCache();
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    // The record table is per database and cached as verified in-process, so
    // empty it instead of dropping it.
    async function clearRecords() {
      if (
        (await db.query(`SELECT to_regclass('_smrt_migrate_runs') AS t`))
          .rows[0]?.t
      ) {
        await db.query('DELETE FROM _smrt_migrate_runs');
      }
    }
    async function run() {
      process.exitCode = undefined;
      logs.mockClear();
      errors.mockClear();
      sent.length = 0;
      await requireCommandHandler(utilityCommands['db:migrate'])([], {
        'postgres-safe': true,
      });
      return [...logs.mock.calls, ...errors.mock.calls]
        .map((c) => c.join(' '))
        .join('\n');
    }
    async function indexState(name: string) {
      return (
        await db.query(
          'SELECT indisvalid, indisready FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid WHERE relname = $1',
          [name],
        )
      ).rows;
    }
    async function recordRows() {
      const exists = (
        await db.query(`SELECT to_regclass('_smrt_migrate_runs') AS t`)
      ).rows[0]?.t;
      if (!exists) return [];
      return (
        await db.query(
          'SELECT fingerprint FROM _smrt_migrate_runs ORDER BY created_at, id',
        )
      ).rows.map((row) => String(row.fingerprint));
    }
    async function productionStart() {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
      // The guard remembers a successful start per database key (url or dbid),
      // so give every call its own key, as a fresh process would have.
      const handle = new Proxy(db, {
        get: (target, property) =>
          property === 'dbid'
            ? `4927r-start-${++startSequence}`
            : Reflect.get(target, property, target),
      });
      try {
        await assertDatabaseMigratedForBuild(handle, {
          engineHint: 'postgres',
        });
      } finally {
        vi.stubEnv('NODE_ENV', 'test');
      }
    }
    const indexStatements = () =>
      sent.filter(
        (sql) => /\bINDEX\b/i.test(sql) && /^\s*(CREATE|DROP)/i.test(sql),
      );

    it('builds every index with CREATE INDEX CONCURRENTLY and leaves them valid (statement 1)', async () => {
      const out = await run();
      expect(process.exitCode ?? 0, out).toBe(0);

      const creates = indexStatements().filter((sql) =>
        /^\s*CREATE/i.test(sql),
      );
      for (const name of [uniqueIndex, plainIndex, createdIndex]) {
        const mine = creates.filter((sql) => sql.includes(name));
        expect(
          mine.length,
          `${name} was never created: ${creates.join('\n')}`,
        ).toBeGreaterThan(0);
        for (const sql of mine) {
          expect(sql).toMatch(
            /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
          );
        }
        expect(await indexState(name)).toEqual([
          { indisvalid: true, indisready: true },
        ]);
      }
      // Not one plain CREATE INDEX reached the database for these indexes.
      expect(
        creates.filter(
          (sql) =>
            !/\bCONCURRENTLY\b/i.test(sql) &&
            [uniqueIndex, plainIndex, createdIndex].some((n) =>
              sql.includes(n),
            ),
        ),
      ).toEqual([]);
      // The concurrent builds ran after the batch committed, not inside it.
      const firstBuild = sent.findIndex((sql) =>
        /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql),
      );
      const lastCommit = sent.findIndex((sql) => /^\s*COMMIT\b/i.test(sql));
      if (lastCommit >= 0) expect(lastCommit).toBeLessThan(firstBuild);
    }, 60_000);

    it('a failed concurrent build exits nonzero and writes no record; the rerun rebuilds, records, and unblocks production start (statements 2 and 3)', async () => {
      // A prior successful migrate, recorded for an older build.
      const stale = 'a'.repeat(64);
      await recordSuccessfulMigrate(db, {
        engineHint: 'postgres',
        input: { ...collectMigrateRecordInput(), fingerprint: stale },
      });
      expect(await recordRows()).toEqual([stale]);
      await db.query(
        `INSERT INTO "${existing}" VALUES ('a', 'same'), ('b', 'same')`,
      );

      const first = await run();
      expect(process.exitCode, first).toBe(1);
      // The unique build was attempted concurrently, and failed.
      expect(
        indexStatements().some((sql) =>
          new RegExp(
            `CREATE\\s+UNIQUE\\s+INDEX\\s+CONCURRENTLY[^]*${uniqueIndex}`,
            'i',
          ).test(sql),
        ),
      ).toBe(true);
      // CONCURRENTLY left an INVALID index behind (a plain build would leave none).
      expect(await indexState(uniqueIndex)).toEqual([
        { indisvalid: false, indisready: expect.any(Boolean) },
      ]);
      // No new record: still only the stale one, so the fingerprint did not advance.
      expect(await recordRows()).toEqual([stale]);
      const last = await readLastMigrateRecord(db, { engineHint: 'postgres' });
      expect(last.state === 'recorded' && last.record.fingerprint).toBe(stale);
      await expect(productionStart()).rejects.toThrow('smrt db:migrate');

      // Remove the cause. The rerun rebuilds the INVALID index.
      await db.query(
        `UPDATE "${existing}" SET title = 'different' WHERE id = 'b'`,
      );
      const second = await run();
      expect(process.exitCode ?? 0, second).toBe(0);
      expect(
        sent.some((sql) =>
          new RegExp(
            `DROP\\s+INDEX\\s+CONCURRENTLY\\s+IF\\s+EXISTS\\s+"?${uniqueIndex}"?`,
            'i',
          ).test(sql),
        ),
      ).toBe(true);
      for (const name of [uniqueIndex, plainIndex, createdIndex]) {
        expect(await indexState(name)).toEqual([
          { indisvalid: true, indisready: true },
        ]);
      }
      const expected = collectMigrateRecordInput().fingerprint;
      expect(await recordRows()).toEqual([stale, expected]);
      await expect(productionStart()).resolves.toBeUndefined();
    }, 90_000);

    it('with no earlier record, a failed concurrent build still writes none and production start is refused (statement 2, first-run database)', async () => {
      await db.query(
        `INSERT INTO "${existing}" VALUES ('a', 'same'), ('b', 'same')`,
      );
      const out = await run();
      expect(process.exitCode, out).toBe(1);
      expect(await recordRows()).toEqual([]);
      await expect(productionStart()).rejects.toThrow('smrt db:migrate');
    }, 60_000);
  },
);
