/**
 * The release floor for a database with no migrate record, on a real
 * PostgreSQL server (`oldest-supported.test.ts` covers SQLite and DuckDB).
 *
 * Migrate records start at 0.61.4, so a database older than the oldest
 * supported release never has one. It is dated by the system-table schema
 * versions earlier releases stamped in `_smrt_migrations`, which can only
 * warn: a stamp dates the system tables, not the application tables.
 *
 * Runs only in the PostgreSQL lane (`DATABASE_URL` / `SMRT_TEST_POSTGRES_URL`).
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import {
  readLastMigrateRecord,
  readRecordedSystemSchema,
} from '../migrate-record.js';
import {
  OLDEST_SUPPORTED_RELEASE,
  OLDEST_SUPPORTED_SYSTEM_SCHEMA,
} from '../oldest-supported.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@happyvertical/logger', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@happyvertical/logger')>();
  return {
    ...original,
    createLogger: (...args: Parameters<typeof original.createLogger>) =>
      Object.assign(original.createLogger(...args), { warn }),
  };
});

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const warned = () =>
  warn.mock.calls
    .flat()
    .filter((message) => String(message).includes('no migrate record'));

describe.skipIf(!pgUrl)(
  'migrate dates a database without a record by its system tables (real PostgreSQL)',
  () => {
    const floor = OLDEST_SUPPORTED_SYSTEM_SCHEMA as string;
    const [major, minor] = floor.split('.').map(Number);
    const older = `${major}.${minor - 1}.0`;
    let admin: DatabaseInterface;
    let db: DatabaseInterface;
    const databases: string[] = [];

    async function stampSystemSchema(...versions: string[]) {
      await db.query(`CREATE TABLE _smrt_migrations (
        id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, description TEXT, checksum TEXT)`);
      for (const version of versions)
        await db.query(
          'INSERT INTO _smrt_migrations (id, version, description) VALUES (?, ?, ?)',
          `stamp-${version}`,
          version,
          'earlier release',
        );
    }
    const hasNote = async () =>
      (
        await db.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'floor_posts' AND column_name = 'note'`,
        )
      ).rows.length > 0;
    const migrate = () =>
      migrateSmrtSchemas({
        db,
        packageName: '@test/gate',
        engineHint: 'postgres',
        postgresSafe: false,
        useConcurrentIndexes: false,
      });

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
    });
    beforeEach(async () => {
      // A database of its own: the floor reads this database's stamps.
      const name = `smrt_floor_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${name}`);
      databases.push(name);
      const url = new URL(pgUrl as string);
      url.pathname = `/${name}`;
      db = (await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `floor-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
        floor_posts: {
          tableName: 'floor_posts',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            note: { type: 'TEXT' },
          },
          indexes: [],
          foreignKeys: [],
          triggers: [],
          dependencies: [],
          version: '',
        },
      });
      await db.query('CREATE TABLE floor_posts (id TEXT PRIMARY KEY)');
      await db.query("INSERT INTO floor_posts VALUES ('old-row')");
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });
    afterAll(async () => {
      for (const name of databases)
        await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin?.close?.();
    });

    it('upgrades a database whose system tables are older than the floor', async () => {
      await stampSystemSchema('1.0.0', older, `${older}+deferred-compat`);
      expect(
        await readRecordedSystemSchema(db, { engineHint: 'postgres' }),
      ).toBe(older);
      warn.mockClear();

      const result = await migrate();

      // A warning, not a stop: the stamp cannot say which release last
      // migrated the application tables.
      expect(result).toMatchObject({
        refused: false,
        releaseStop: null,
        applied: true,
      });
      expect(await hasNote()).toBe(true);
      // ... and it says so, once.
      expect(warned()).toHaveLength(1);
      expect(String(warned()[0])).toContain(
        `older than ${OLDEST_SUPPORTED_RELEASE} (system schema ${older}`,
      );
    });

    it('does not let a malformed stamp outrank the real one', async () => {
      await stampSystemSchema(older, '9.0.0garbage');
      expect(
        await readRecordedSystemSchema(db, { engineHint: 'postgres' }),
      ).toBe(older);
      warn.mockClear();

      await migrate();

      expect(warned()).toHaveLength(1);
    });

    it('upgrades a database the oldest supported release prepared', async () => {
      await stampSystemSchema('1.0.0', floor);
      warn.mockClear();

      expect(await migrate()).toMatchObject({
        refused: false,
        releaseStop: null,
        applied: true,
      });
      expect(await hasNote()).toBe(true);
      expect(warned()).toHaveLength(0);
    });

    it('upgrades a database that has no system tables at all', async () => {
      expect(
        await readRecordedSystemSchema(db, { engineHint: 'postgres' }),
      ).toBe(null);

      expect(await migrate()).toMatchObject({ refused: false, applied: true });
      expect(await hasNote()).toBe(true);
    });
  },
);
