import { randomUUID } from 'node:crypto';
import {
  getTestDbConfig,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import '../models/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres('3329 concurrent cold catalog seeding', () => {
  it('converges from two independent connections without duplicate grants or catalog rows', async () => {
    const config = getTestDbConfig();
    const first = await getDatabase({
      ...config,
      dbid: `seed-first-${randomUUID()}`,
    });
    const second = await getDatabase({
      ...config,
      dbid: `seed-second-${randomUUID()}`,
    });
    try {
      const a = await RoleCollection.create({ db: first });
      const b = await RoleCollection.create({ db: second });
      for (let iteration = 0; iteration < 2; iteration++) {
        await first.query(
          'TRUNCATE role_permissions, permissions, roles CASCADE',
        );
        const seeded = await Promise.all([
          a.seedSystemRoles({ seedPermissions: true }),
          b.seedSystemRoles({ seedPermissions: true }),
        ]);
        expect(seeded[0].map((role) => role.id)).toEqual(
          seeded[1].map((role) => role.id),
        );
        for (const [table, key] of [
          ['role_permissions', 'role_id, permission_id'],
          ['permissions', 'slug, context'],
          ['roles', 'tenant_id, slug, context'],
        ]) {
          const duplicates = await first.query(
            `SELECT ${key} FROM ${table} GROUP BY ${key} HAVING COUNT(*) > 1`,
          );
          expect(duplicates.rows, table).toEqual([]);
        }
        const owner = seeded[0].find((role) => role.slug === 'owner')!;
        const counts = await first.query(
          'SELECT (SELECT COUNT(*) FROM permissions) AS permissions, (SELECT COUNT(*) FROM role_permissions WHERE role_id = ?) AS grants',
          owner.id,
        );
        expect(Number(counts.rows[0].grants)).toBe(
          Number(counts.rows[0].permissions),
        );
        expect(Number(counts.rows[0].permissions)).toBeGreaterThan(0);
        const before = await first.query(
          'SELECT id FROM role_permissions ORDER BY id',
        );
        await Promise.all([
          a.seedSystemRoles({ seedPermissions: true }),
          b.seedSystemRoles({ seedPermissions: true }),
        ]);
        expect(
          (await first.query('SELECT id FROM role_permissions ORDER BY id'))
            .rows,
        ).toEqual(before.rows);
      }
    } finally {
      await first.close?.();
      await second.close?.();
    }
  }, 120_000);

  it('uses caller transaction and rolls back grant writes before retry', async () => {
    const db = await getDatabase({ ...getTestDbConfig(), dbid: randomUUID() });
    try {
      const roles = await RoleCollection.create({ db });
      await roles.seedSystemRoles({ seedPermissions: true });
      await db.query('DELETE FROM role_permissions');
      await expect(
        db.transaction!(async (tx) => {
          const grants = await RolePermissionCollection.create({ db: tx });
          await grants.seedRolePermissions();
          throw new Error('caller rollback');
        }),
      ).rejects.toThrow('caller rollback');
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS count FROM role_permissions'))
            .rows[0].count,
        ),
      ).toBe(0);
      await roles.seedSystemRoles({ seedPermissions: true });
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS count FROM role_permissions'))
            .rows[0].count,
        ),
      ).toBeGreaterThan(0);
    } finally {
      await db.close?.();
    }
  });

  it('keeps system-role seeding on the caller transaction through rollback and retry', async () => {
    const db = await getDatabase({ ...getTestDbConfig(), dbid: randomUUID() });
    try {
      await db.query('TRUNCATE role_permissions, permissions, roles CASCADE');
      await expect(
        db.transaction!(async (tx) => {
          const roles = await RoleCollection.create({ db: tx });
          const seeded = await roles.seedSystemRoles({ seedPermissions: true });
          expect(seeded).toHaveLength(4);
          // Returned models must remain bound to this live caller transaction.
          seeded[0].name = 'Transactional role';
          await seeded[0].save();
          throw new Error('rollback system roles');
        }),
      ).rejects.toThrow('rollback system roles');
      for (const table of ['roles', 'permissions', 'role_permissions']) {
        expect(
          Number(
            (await db.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0]
              .count,
          ),
          table,
        ).toBe(0);
      }
      const roles = await RoleCollection.create({ db });
      expect(
        await roles.seedSystemRoles({ seedPermissions: true }),
      ).toHaveLength(4);
    } finally {
      await db.close?.();
    }
  });
});
