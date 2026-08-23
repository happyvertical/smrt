/**
 * Issue #2364 (epic #2382, finding A3) — read-path lookup columns indexed on
 * the PRODUCTION manifest schema path.
 *
 * `createIsolatedTestDbFromManifest()` with no explicit path auto-detects
 * this package's own freshly-generated manifest and renders tables + indexes
 * through the same structured-schema renderer `smrt db:migrate` uses (#2358)
 * — so this proves the `indexed: true` opt-ins are actually emitted for the
 * real shipped classes, not just the schema generator's synthetic fixtures in
 * `@happyvertical/smrt-core`'s `schema-path-parity.test.ts`.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Row = Record<string, unknown>;

async function rows(db: DatabaseInterface, sql: string): Promise<Row[]> {
  const result = await db.query(sql);
  return Array.isArray(result)
    ? (result as Row[])
    : ((result as { rows?: Row[] }).rows ?? []);
}

async function indexNames(
  db: DatabaseInterface,
  tableName: string,
): Promise<string[]> {
  const result = await rows(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${tableName}'`,
  );
  return result.map((row) => String(row.name));
}

async function uniqueIndexColumns(
  db: DatabaseInterface,
  tableName: string,
): Promise<string[][]> {
  const indexes = await rows(db, `PRAGMA index_list('${tableName}')`);
  const uniqueIndexes = indexes.filter((row) => Number(row.unique) === 1);
  return await Promise.all(
    uniqueIndexes.map(async (index) => {
      const columns = await rows(
        db,
        `PRAGMA index_info('${String(index.name)}')`,
      );
      return columns.map((column) => String(column.name));
    }),
  );
}

describe('read-path lookup indexes reach the production manifest schema path (#2364)', () => {
  let baseDb: DatabaseInterface;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ baseDb, cleanup } = await createIsolatedTestDbFromManifest({
      includeObjects: ['User', 'UsersCliAuthRequest'],
    }));
  });

  afterEach(async () => {
    await cleanup();
  });

  it("indexes `users.email` — `findByEmail()`'s raw lookup column, distinct from the `email_key` uniqueness constraint", async () => {
    const names = await indexNames(baseDb, 'users');
    expect(names).toContain('users_email_idx');
  });

  it('indexes the CLI device-code grant lookups on `users_cli_auth_requests`', async () => {
    const uniqueColumns = await uniqueIndexColumns(
      baseDb,
      'users_cli_auth_requests',
    );
    // These unique indexes both accelerate the hot lookups and arbitrate
    // concurrent request issuance.
    expect(uniqueColumns).toContainEqual(['user_code']);
    expect(uniqueColumns).toContainEqual(['device_code_hash']);
  });
});
