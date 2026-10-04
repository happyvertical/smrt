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
import { deduplicateRolePermissions } from '../migrations/deduplicateRolePermissions.js';

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
      dbid: `3329-admin-${id}`,
      __smrtSkipVitestSchemaPreparation: true,
    });
    const name = `smrt_grants_${id}`;
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
    const path = join(tmpdir(), `smrt-3329-${id}.db`);
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
    'CREATE TABLE role_permissions (id TEXT PRIMARY KEY, role_id TEXT NOT NULL, permission_id TEXT NOT NULL, created_at TIMESTAMP)',
  );
  for (const [id, role, permission, date] of [
    ['old', 'r1', 'p1', '2020-01-01'],
    ['new', 'r1', 'p1', '2021-01-01'],
    ['other-role', 'r2', 'p1', '2022-01-01'],
    ['other-permission', 'r1', 'p2', '2022-01-01'],
    ['tie-b', 'r2', 'p2', '2020-01-01'],
    ['tie-a', 'r2', 'p2', '2020-01-01'],
  ])
    await db.query(
      'INSERT INTO role_permissions VALUES (?, ?, ?, ?)',
      id,
      role,
      permission,
      date,
    );
  return db;
}

for (const dialect of dialects) {
  describe(`grant maintenance migration (${dialect})`, () => {
    it('requires maintenance, previews without writing, keeps oldest and installs uniqueness idempotently', async () => {
      const db = await fixture(dialect);
      await expect(deduplicateRolePermissions(db)).rejects.toThrow(
        'Stop all writers',
      );
      const noTransaction = new Proxy(db, {
        get(target, key) {
          if (key === 'transaction') return undefined;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(
        deduplicateRolePermissions(noTransaction, {
          maintenanceConfirmed: true,
        }),
      ).rejects.toThrow('requires a root transaction handle');
      await expect(
        deduplicateRolePermissions(db, { dryRun: true }),
      ).resolves.toEqual({ duplicates: 2, removed: 0 });
      await expect(
        deduplicateRolePermissions(db, { maintenanceConfirmed: true }),
      ).resolves.toEqual({ duplicates: 2, removed: 2 });
      const rows = await db.query(
        'SELECT id FROM role_permissions ORDER BY id',
      );
      expect(rows.rows.map((row) => row.id)).toEqual([
        'old',
        'other-permission',
        'other-role',
        'tie-a',
      ]);
      await expect(
        deduplicateRolePermissions(db, { maintenanceConfirmed: true }),
      ).resolves.toEqual({ duplicates: 0, removed: 0 });
      await db.upsert('role_permissions', ['role_id', 'permission_id'], {
        id: 'old',
        role_id: 'r1',
        permission_id: 'p1',
        created_at: '2020-01-01',
      });
      await expect(
        db.query(
          "INSERT INTO role_permissions VALUES ('duplicate', 'r1', 'p1', '2023-01-01')",
        ),
      ).rejects.toThrow();
    });

    it('rolls deletions back when index creation fails, then retries safely', async () => {
      const db = await fixture(dialect);
      const failing = new Proxy(db, {
        get(target, property) {
          if (property === 'transaction')
            return (callback: (tx: DatabaseInterface) => Promise<unknown>) =>
              target.transaction!(async (tx) =>
                callback(
                  new Proxy(tx, {
                    get(bound, key) {
                      if (key === 'query')
                        return (sql: string, ...args: unknown[]) => {
                          if (sql.startsWith('CREATE UNIQUE INDEX'))
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
        deduplicateRolePermissions(failing, { maintenanceConfirmed: true }),
      ).rejects.toThrow('forced index failure');
      await expect(
        deduplicateRolePermissions(db, { dryRun: true }),
      ).resolves.toEqual({ duplicates: 2, removed: 0 });
      await expect(
        deduplicateRolePermissions(db, { maintenanceConfirmed: true }),
      ).resolves.toEqual({ duplicates: 2, removed: 2 });
    });
  });
}
