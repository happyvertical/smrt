import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import '../models/index.js';

for (const type of ['sqlite'] as const) {
  describe(`grant identity (${type})`, () => {
    it('preserves pair identity, separates roles and rolls caller transactions back', async () => {
      const path = join(tmpdir(), `smrt-grant-identity-${randomUUID()}.db`);
      const db = await getDatabase({ type, url: path });
      try {
        const roles = await RoleCollection.create({ db });
        const permissions = await PermissionCollection.create({ db });
        const grants = await RolePermissionCollection.create({ db });
        const owner = await roles.create({ slug: 'owner', isSystem: true });
        const viewer = await roles.create({ slug: 'viewer', isSystem: true });
        const read = await permissions.create({ slug: 'documents.read' });
        const write = await permissions.create({ slug: 'documents.update' });
        const first = await grants.create({
          roleId: owner.id,
          permissionId: read.id,
        });
        const again = await grants.create({
          roleId: owner.id,
          permissionId: read.id,
        });
        expect(again.id).toBe(first.id);
        expect(await grants.hasPermission(viewer.id!, read.id!)).toBe(false);
        expect(await grants.hasPermission(owner.id!, write.id!)).toBe(false);
        await expect(
          db.transaction!(async (tx) => {
            const scoped = await RolePermissionCollection.create({ db: tx });
            await scoped.addPermission(viewer.id!, read.id!);
            throw new Error('rollback grant');
          }),
        ).rejects.toThrow('rollback grant');
        expect(await grants.hasPermission(viewer.id!, read.id!)).toBe(false);
        await grants.addPermission(viewer.id!, read.id!);
        expect(await grants.hasPermission(viewer.id!, read.id!)).toBe(true);
      } finally {
        await db.close?.();
        rmSync(path, { force: true });
      }
    });
  });
}
