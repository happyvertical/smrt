import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTestDbConfig,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { deduplicateAuthorityPairs } from '../migrations/deduplicateAuthorityPairs.js';

const dialects = [
  'sqlite',
  'duckdb',
  ...(isPostgresAvailable() ? ['postgres'] : []),
] as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(type: string): Promise<DatabaseInterface> {
  const id = randomUUID().replaceAll('-', '');
  let db: DatabaseInterface;
  if (type === 'postgres') {
    const config = getTestDbConfig();
    const admin = await getDatabase({
      ...config,
      dbid: `3375-admin-${id}`,
      __smrtSkipVitestSchemaPreparation: true,
    });
    const name = `smrt_pairs_${id}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(config.url);
    url.pathname = `/${name}`;
    db = await getDatabase({
      type: 'postgres',
      url: url.toString(),
      dbid: id,
      __smrtSkipVitestSchemaPreparation: true,
    });
    cleanups.push(async () => {
      await db.close?.();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close?.();
    });
  } else {
    const path = join(tmpdir(), `smrt-3375-${id}.db`);
    db = await getDatabase({
      type: type as 'sqlite' | 'duckdb',
      url: path,
      __smrtSkipVitestSchemaPreparation: true,
    });
    cleanups.push(async () => {
      await db.close?.();
      rmSync(path, { force: true });
    });
  }
  await db.query(
    'CREATE TABLE membership_overrides (id TEXT PRIMARY KEY, membership_id TEXT NOT NULL, permission_id TEXT NOT NULL, effect TEXT, created_at TIMESTAMP)',
  );
  await db.query(
    'CREATE TABLE tenant_permission_overrides (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, permission_id TEXT NOT NULL, effect TEXT, created_at TIMESTAMP)',
  );
  await db.query(
    'CREATE TABLE group_members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TIMESTAMP)',
  );
  for (const row of [
    // An older GRANT and a newer DENY: the resolver applies DENY, keep it.
    ['m-grant-old', 'm1', 'p1', 'grant', '2020-01-01'],
    ['m-deny-new', 'm1', 'p1', 'deny', '2021-01-01'],
    // Two grants: keep the oldest.
    ['m-grant-a', 'm1', 'p2', 'grant', '2020-01-01'],
    ['m-grant-b', 'm1', 'p2', 'grant', '2022-01-01'],
    ['m-other', 'm2', 'p1', 'grant', '2022-01-01'],
  ])
    await db.query(
      'INSERT INTO membership_overrides VALUES (?, ?, ?, ?, ?)',
      ...row,
    );
  for (const row of [
    ['t-inherit', 't1', 'p1', 'inherit', '2019-01-01'],
    ['t-grant', 't1', 'p1', 'grant', '2020-01-01'],
    ['t-deny', 't1', 'p2', 'deny', '2023-01-01'],
    ['t-grant-2', 't1', 'p2', 'grant', '2020-01-01'],
    ['t-inherit-2', 't1', 'p2', 'inherit', '2019-01-01'],
    ['t-other', 't2', 'p1', 'grant', '2020-01-01'],
  ])
    await db.query(
      'INSERT INTO tenant_permission_overrides VALUES (?, ?, ?, ?, ?)',
      ...row,
    );
  for (const row of [
    ['g-tie-b', 'g1', 'u1', '2020-01-01'],
    ['g-tie-a', 'g1', 'u1', '2020-01-01'],
    ['g-null', 'g1', 'u1', null],
    ['g-other', 'g1', 'u2', '2021-01-01'],
  ])
    await db.query('INSERT INTO group_members VALUES (?, ?, ?, ?)', ...row);
  return db;
}

async function ids(db: DatabaseInterface, table: string): Promise<string[]> {
  const result = await db.query(`SELECT id FROM ${table} ORDER BY id`);
  return result.rows.map((row) => String(row.id));
}

const expected = {
  membershipOverrides: { duplicates: 2, removed: 2 },
  tenantPermissionOverrides: { duplicates: 3, removed: 3 },
  groupMembers: { duplicates: 2, removed: 2 },
};

for (const dialect of dialects) {
  describe(`authority pair maintenance migration (${dialect})`, () => {
    it('keeps the effective override per pair and installs uniqueness idempotently', async () => {
      const db = await fixture(dialect);
      await expect(deduplicateAuthorityPairs(db)).rejects.toThrow(
        'Stop all writers',
      );
      await expect(
        deduplicateAuthorityPairs(db, { dryRun: true }),
      ).resolves.toEqual({
        membershipOverrides: { duplicates: 2, removed: 0 },
        tenantPermissionOverrides: { duplicates: 3, removed: 0 },
        groupMembers: { duplicates: 2, removed: 0 },
      });
      await expect(
        deduplicateAuthorityPairs(db, { maintenanceConfirmed: true }),
      ).resolves.toEqual(expected);
      expect(await ids(db, 'membership_overrides')).toEqual([
        'm-deny-new',
        'm-grant-a',
        'm-other',
      ]);
      expect(await ids(db, 'tenant_permission_overrides')).toEqual([
        't-deny',
        't-grant',
        't-other',
      ]);
      expect(await ids(db, 'group_members')).toEqual(['g-other', 'g-tie-a']);
      await expect(
        deduplicateAuthorityPairs(db, { maintenanceConfirmed: true }),
      ).resolves.toEqual({
        membershipOverrides: { duplicates: 0, removed: 0 },
        tenantPermissionOverrides: { duplicates: 0, removed: 0 },
        groupMembers: { duplicates: 0, removed: 0 },
      });
      for (const insert of [
        "INSERT INTO membership_overrides VALUES ('dup', 'm1', 'p1', 'grant', '2024-01-01')",
        "INSERT INTO tenant_permission_overrides VALUES ('dup', 't1', 'p1', 'grant', '2024-01-01')",
        "INSERT INTO group_members VALUES ('dup', 'g1', 'u1', '2024-01-01')",
      ]) {
        await expect(db.query(insert)).rejects.toThrow();
      }
    });

    it('rolls every table back when a later index fails, then retries safely', async () => {
      const db = await fixture(dialect);
      const failing = new Proxy(db, {
        get(target, property) {
          const transaction = target.transaction?.bind(target);
          if (property === 'transaction' && transaction)
            return (callback: (tx: DatabaseInterface) => Promise<unknown>) =>
              transaction(async (tx) =>
                callback(
                  new Proxy(tx, {
                    get(bound, key) {
                      if (key === 'query')
                        return (sql: string, ...args: unknown[]) => {
                          if (
                            sql.startsWith('CREATE UNIQUE INDEX') &&
                            sql.includes('group_members')
                          )
                            throw new Error('forced index failure');
                          return bound.query(sql, ...args);
                        };
                      const value = Reflect.get(bound, key);
                      return typeof value === 'function'
                        ? value.bind(bound)
                        : value;
                    },
                  }),
                ),
              );
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(
        deduplicateAuthorityPairs(failing, { maintenanceConfirmed: true }),
      ).rejects.toThrow('forced index failure');
      expect(await ids(db, 'membership_overrides')).toHaveLength(5);
      await expect(
        deduplicateAuthorityPairs(db, { maintenanceConfirmed: true }),
      ).resolves.toEqual(expected);
    });
  });
}
