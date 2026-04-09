import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import {
  generatePostgresPermissionSql,
  PermissionCatalogService,
  registerPermissionDefinitions,
  syncPermissionCatalog,
} from '../services/index.js';

@smrt({
  api: { include: ['list', 'create', 'publish'] },
  cli: { include: ['get', 'archive'] },
  collection: 'permission_catalog_records',
  mcp: { include: ['update'] },
  tenantScoped: { mode: 'required' },
})
class PermissionCatalogRecord extends SmrtObject {
  tenantId: string = '';
  title: string = '';

  async publish(): Promise<boolean> {
    return true;
  }

  async archive(): Promise<boolean> {
    return true;
  }

  async internalOnly(): Promise<boolean> {
    return false;
  }
}

@smrt({
  api: { include: ['list'] },
  collection: 'optional_permission_catalog_records',
  tenantScoped: { mode: 'optional' },
})
class OptionalPermissionCatalogRecord extends SmrtObject {
  name: string = '';
  tenantId: string | null = null;
}

describe('PermissionCatalogService', () => {
  const cleanupFns: Array<() => void> = [];
  const dbPaths: string[] = [];

  afterEach(() => {
    clearCache();
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }

    for (const dbPath of dbPaths.splice(0, dbPaths.length)) {
      if (existsSync(dbPath)) {
        rmSync(dbPath, { force: true });
      }
    }
  });

  it('should derive CRUD and exposed custom permissions from the manifest', () => {
    const catalog = PermissionCatalogService.create().getCatalog();
    const matchingSlugs = catalog.permissions
      .map((permission) => permission.slug)
      .filter((slug) => slug.startsWith('permission_catalog_records.'));

    expect(matchingSlugs).toContain('permission_catalog_records.read');
    expect(
      matchingSlugs.filter(
        (slug) => slug === 'permission_catalog_records.read',
      ),
    ).toHaveLength(1);
    expect(matchingSlugs).toContain('permission_catalog_records.create');
    expect(matchingSlugs).toContain('permission_catalog_records.update');
    expect(matchingSlugs).toContain('permission_catalog_records.publish');
    expect(matchingSlugs).toContain('permission_catalog_records.archive');
    expect(matchingSlugs).not.toContain('permission_catalog_records.delete');
    expect(matchingSlugs).not.toContain(
      'permission_catalog_records.internalOnly',
    );
  });

  it('should merge config and runtime permissions and reject incompatible collisions', () => {
    setConfig({
      packages: {
        users: {
          permissions: {
            custom: [
              {
                category: 'app',
                description: 'Allows managing the application',
                name: 'Manage Application',
                slug: 'app.manage',
              },
            ],
          },
        },
      },
    });

    const unregister = registerPermissionDefinitions([
      {
        category: 'app',
        description: 'Allows exporting the application',
        name: 'Export Application',
        slug: 'app.export',
      },
    ]);
    cleanupFns.push(unregister);

    const catalog = PermissionCatalogService.create().getCatalog();
    expect(catalog.permissions.map((permission) => permission.slug)).toContain(
      'app.manage',
    );
    expect(catalog.permissions.map((permission) => permission.slug)).toContain(
      'app.export',
    );

    setConfig({
      packages: {
        users: {
          permissions: {
            custom: [
              {
                name: 'Config Name',
                slug: 'app.conflict',
              },
            ],
          },
        },
      },
    });

    const unregisterConflict = registerPermissionDefinitions([
      {
        name: 'Runtime Name',
        slug: 'app.conflict',
      },
    ]);
    cleanupFns.push(unregisterConflict);

    expect(() => PermissionCatalogService.create().getCatalog()).toThrow(
      /Conflicting permission metadata/,
    );
  });

  it('should sync permissions by slug and update metadata without deleting stale rows', async () => {
    const dbPath = join(tmpdir(), `smrt-permission-catalog-${Date.now()}.db`);
    dbPaths.push(dbPath);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    setConfig({
      packages: {
        users: {
          permissions: {
            custom: [
              {
                category: 'app',
                description: 'First description',
                name: 'Manage Application',
                slug: 'app.manage',
              },
            ],
          },
        },
      },
    });

    const firstSync = await syncPermissionCatalog(options);
    expect(firstSync.created).toContain('app.manage');

    const permissions = await PermissionCollection.create(options);
    const created = await permissions.findBySlug('app.manage');
    expect(created?.name).toBe('Manage Application');
    expect(created?.description).toBe('First description');

    setConfig({
      packages: {
        users: {
          permissions: {
            custom: [
              {
                category: 'app',
                description: 'Updated description',
                name: 'Manage App',
                slug: 'app.manage',
              },
            ],
          },
        },
      },
    });

    const secondSync = await syncPermissionCatalog(options);
    expect(secondSync.updated).toContain('app.manage');

    const updated = await permissions.findBySlug('app.manage');
    expect(updated?.name).toBe('Manage App');
    expect(updated?.description).toBe('Updated description');
  });

  it('should generate Postgres policy SQL for required tenant-scoped tables and explicit bindings', () => {
    const unregister = registerPermissionDefinitions([
      {
        postgres: {
          bindings: [
            {
              action: 'select',
              tableName: 'permission_catalog_records',
            },
          ],
        },
        slug: 'permission_catalog_records.audit',
      },
    ]);
    cleanupFns.push(unregister);

    const result = generatePostgresPermissionSql();
    const target = result.targets.find(
      (item) => item.tableName === 'permission_catalog_records',
    );

    expect(target).toBeDefined();
    expect(target?.actions.SELECT).toContain('permission_catalog_records.read');
    expect(target?.actions.SELECT).toContain(
      'permission_catalog_records.audit',
    );
    expect(result.sql).toContain(
      'CREATE OR REPLACE FUNCTION smrt_has_permission',
    );
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          className: 'OptionalPermissionCatalogRecord',
          reason: expect.stringContaining("tenant mode 'optional'"),
        }),
      ]),
    );
  });
});
