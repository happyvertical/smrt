/**
 * Real PostgreSQL half of the reference fixture contract. It runs only through
 * the repository's disposable `test:postgres` service wrapper; ordinary local
 * test runs remain fully file-backed SQLite.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  copyRuntimeProfileReference,
  generateReferenceFixtureManifest,
  openReferencePostgresDatabase,
  prepareReferenceFixtureDatabase,
} from '../fixtures/runtime-profile-reference/index.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe
  : describe.skip;

let temporaryDirectory: string | undefined;
let tableName: string | undefined;
let db: Awaited<ReturnType<typeof openReferencePostgresDatabase>> | undefined;

afterEach(async () => {
  if (db && tableName) {
    await db.query('DROP TABLE IF EXISTS "reference_work_item_assets" CASCADE');
    await db.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
  }
  await db?.close?.();
  db = undefined;
  tableName = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

postgresDescribe('runtime-profile reference fixture PostgreSQL contract', () => {
  it('migrates the generated fixture schema on the disposable PostgreSQL service', async () => {
    temporaryDirectory = mkdtempSync(
      join(realpathSync(tmpdir()), 'smrt-runtime-profile-postgres-'),
    );
    const fixture = copyRuntimeProfileReference(join(temporaryDirectory, 'app'));
    const manifest = await generateReferenceFixtureManifest(fixture);
    const workItem = Object.values(manifest.objects).find(
      (object) => object.className === 'ReferenceWorkItem',
    );
    tableName = workItem?.schema?.tableName;
    expect(tableName).toBe('reference_work_items');

    db = await openReferencePostgresDatabase();
    await prepareReferenceFixtureDatabase(db, manifest, 'postgres');
    const rows = await db.query(
      'SELECT COUNT(*) AS count FROM "reference_work_items"',
    );
    expect(Number((rows.rows[0] as { count: unknown }).count)).toBe(0);
  });
});
