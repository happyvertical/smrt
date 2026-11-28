/**
 * Migration checksum verification against a real PostgreSQL server
 * (`pnpm --filter @happyvertical/smrt-core test:postgres`).
 *
 * Verifies `MigrationTracker` on PostgreSQL for `v2:` quoted-text checksums
 * (`'...'`, `E'...'`, `"..."`, `$$...$$`, `$tag$...$tag$`), comment/whitespace
 * invariance outside quotes, and legacy unprefixed (`v1`) record compatibility
 * including forced re-runs.
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
} from 'vitest';
import { classifyDatabaseError } from '../../db-errors.js';
import type { MigrationDefinition } from '../../schema/types.js';
import {
  checksumMatchesRecorded,
  computeChecksum,
  computeQuotedTextChecksum,
  verifyRecordedChecksum,
} from '../checksum.js';
import { MigrationTracker } from '../tracker.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

const isObjectInUse = (error: unknown) =>
  classifyDatabaseError(error).driverCodes.includes('55006');

describe.skipIf(!pgUrl)(
  'MigrationTracker quoted-text checksums on real PostgreSQL',
  () => {
    let admin: DatabaseInterface;
    let db: DatabaseInterface;
    let tracker: MigrationTracker;
    const databases: string[] = [];

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
    });

    beforeEach(async () => {
      const name = `smrt_chk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${name}`);
      databases.push(name);
      const url = new URL(pgUrl as string);
      url.pathname = `/${name}`;
      db = (await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `chk-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      tracker = new MigrationTracker({ db, engineHint: 'postgres' });
      await tracker.initialize();
    });

    afterEach(async () => {
      await db?.close?.();
    });

    afterAll(async () => {
      try {
        for (const name of databases) {
          for (let attempt = 0; ; attempt++) {
            try {
              await admin.query(`DROP DATABASE IF EXISTS ${name}`);
              break;
            } catch (error) {
              if (attempt >= 20 || !isObjectInUse(error)) throw error;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
        }
      } finally {
        await admin?.close?.();
      }
    });

    it.each([
      [
        'single-quoted string literal',
        "CREATE TABLE notes_sq (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a  b')",
        "CREATE TABLE notes_sq (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a b')",
        "CREATE TABLE /* keep */ notes_sq (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a  b') -- note",
      ],
      [
        'escape string literal (E-string)',
        "SELECT E'it\\'s --old' AS val",
        "SELECT E'it\\'s --new' AS val",
        "SELECT /* comment */   E'it\\'s --old' AS val -- note",
      ],
      [
        'double-quoted identifier',
        'CREATE TABLE "quoted  tbl" (id TEXT PRIMARY KEY)',
        'CREATE TABLE "quoted tbl" (id TEXT PRIMARY KEY)',
        'CREATE TABLE  /* c */ "quoted  tbl" (id TEXT PRIMARY KEY) -- end',
      ],
      [
        'anonymous dollar-quoted body',
        'DO $$ BEGIN PERFORM 1; -- a  b\nEND $$',
        'DO $$ BEGIN PERFORM 1; -- a b\nEND $$',
        'DO /* outer */ $$ BEGIN PERFORM 1; -- a  b\nEND $$ -- end',
      ],
      [
        'named dollar-quoted body',
        'DO $fn$ BEGIN PERFORM 1; /* a  b */ END $fn$',
        'DO $fn$ BEGIN PERFORM 1; /* a b */ END $fn$',
        'DO   $fn$ BEGIN PERFORM 1; /* a  b */ END $fn$ /* end */',
      ],
    ])('records v2: checksum, refuses edited %s, and allows outside-quote comments/whitespace', async (_label, originalSql, editedQuotedSql, reformattedSql) => {
      const original: MigrationDefinition = {
        id: '0001_pg_quoted',
        description: 'PostgreSQL quoted checksum test',
        version: '1.0.0',
        up: [originalSql],
        down: [],
      };

      const applied = await tracker.applyAll([original]);
      expect(applied[0]).toMatchObject({ success: true, applied: true });
      expect(applied[0].checksum).toMatch(/^v2:[a-f0-9]{64}$/);
      expect(applied[0].checksum).toBe(computeQuotedTextChecksum(original.up));

      const row = await tracker.getMigration(original.id);
      expect(row?.checksum).toBe(applied[0].checksum);
      expect(row?.applied_checksum).toBe(applied[0].checksum);
      expect(
        verifyRecordedChecksum(
          original.up,
          row?.checksum as string,
          row?.applied_checksum,
        ),
      ).toEqual({ valid: true });

      const reformatted: MigrationDefinition = {
        ...original,
        up: [reformattedSql],
      };
      const skipped = await tracker.applyAll([reformatted]);
      expect(skipped[0]).toMatchObject({ success: true, skipped: true });
      expect(await tracker.detectDrift([reformatted])).toEqual([]);

      const edited: MigrationDefinition = {
        ...original,
        up: [editedQuotedSql],
      };
      const refused = await tracker.applyAll([edited]);
      expect(refused[0].success).toBe(false);
      expect(refused[0].error).toContain('checksum mismatch');
      expect(await tracker.detectDrift([edited])).toEqual([
        expect.objectContaining({
          migration_name: original.id,
          drift_type: 'file_modified',
        }),
      ]);
    });

    it('matches an existing unprefixed v1 row and keeps unprefixed format on forced re-run', async () => {
      const original: MigrationDefinition = {
        id: '0001_pg_legacy_v1',
        description: 'Legacy unprefixed checksum test',
        version: '1.0.0',
        up: [
          "CREATE TABLE legacy_notes (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a  b')",
        ],
        down: [],
      };
      const legacyChecksum = computeChecksum(original.up);
      expect(legacyChecksum).not.toMatch(/^v2:/);

      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, applied_checksum, status, attempts, is_reversible, batch)
         VALUES ('legacy-pg-1', $1, '1.0.0', $2, $3, 'completed', 1, 0, 1)`,
        original.id,
        legacyChecksum,
        legacyChecksum,
      );

      const skipped = await tracker.apply(original);
      expect(skipped).toMatchObject({ success: true, skipped: true });
      expect(await tracker.detectDrift([original])).toEqual([]);

      const edited: MigrationDefinition = {
        ...original,
        up: [
          "CREATE TABLE IF NOT EXISTS legacy_notes (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a   b')",
        ],
      };
      const refused = await tracker.apply(edited);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('checksum mismatch');

      const forced = await tracker.apply(edited, { force: true });
      expect(forced.success).toBe(true);
      expect(forced.applied).toBe(true);

      const row = await tracker.getMigration(original.id);
      const expectedEditedV1 = computeChecksum(edited.up);
      expect(row?.checksum).toBe(expectedEditedV1);
      expect(row?.checksum).not.toMatch(/^v2:/);
      expect(row?.applied_checksum).toBe(expectedEditedV1);
      expect(checksumMatchesRecorded(edited.up, row?.checksum as string)).toBe(
        true,
      );
      expect(await tracker.detectDrift([edited])).toEqual([]);
    });
  },
);
