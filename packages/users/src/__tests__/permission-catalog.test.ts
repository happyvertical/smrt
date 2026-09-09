import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  @field({ readPermission: 'permission_catalog_records.read.internal' })
  internalNote: string = '';

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

@smrt({
  api: false,
  cli: true,
  collection: 'default_exposure_permission_catalog_records',
  mcp: true,
  tenantScoped: { mode: 'required' },
})
class DefaultExposurePermissionCatalogRecord extends SmrtObject {
  tenantId: string = '';
  title: string = '';

  async summarize(): Promise<boolean> {
    return true;
  }

  protected async hidden(): Promise<boolean> {
    return false;
  }
}

@smrt({
  api: { include: ['list', 'create', 'update', 'delete'] },
  collection: 'long_policy_permission_catalog_records',
  tableName:
    'permission_policy_table_name_that_is_far_too_long_for_postgres_identifier_limits',
  tenantScoped: { mode: 'required' },
})
class LongPolicyPermissionCatalogRecord extends SmrtObject {
  tenantId: string = '';
  title: string = '';
}

describe('PermissionCatalogService', () => {
  const cleanupFns: Array<() => void> = [];
  const dbPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('derives each current supplied registry snapshot once without metadata or relationship projection', () => {
    class SharedPermissionRecord2802 extends SmrtObject {}
    class OtherPermissionRecord2802 extends SmrtObject {}

    const shared = {
      config: {
        collection: 'catalog_a_2802',
        api: { include: ['list', 'create'] },
        mcp: { include: ['publish', 'hidden'] },
      },
      constructor: SharedPermissionRecord2802,
      fields: new Map([['ignored', { type: 'text' }]]),
      inheritedFields: new Map([
        [
          'inheritedVisible',
          {
            _meta: {
              readPermission: 'catalog_a_2802.read.inherited',
            },
            type: 'text',
          },
        ],
      ]),
      methods: new Map([
        ['publish', { isPublic: true, name: 'publish' }],
        ['hidden', { isPublic: false, name: 'hidden' }],
      ]),
      name: 'SharedPermissionRecord2802',
      packageName: '@catalog/a',
      qualifiedName: '@catalog/a:SharedPermissionRecord2802',
    } as unknown as ReturnType<typeof ObjectRegistry.getAllClasses> extends Map<
      string,
      infer Registered
    >
      ? Registered
      : never;
    const other = {
      config: {
        collection: 'catalog_b_2802',
        api: { include: ['list', 'delete'] },
        mcp: { include: ['publish'] },
      },
      constructor: OtherPermissionRecord2802,
      fields: new Map(),
      methods: new Map([['publish', { isPublic: true, name: 'publish' }]]),
      name: 'SharedPermissionRecord2802',
      packageName: '@catalog/b',
      qualifiedName: '@catalog/b:SharedPermissionRecord2802',
    } as typeof shared;

    const registrations = new Map([
      ['@catalog/a:SharedPermissionRecord2802', shared],
      ['SharedPermissionRecord2802', shared],
      ['@catalog/b:SharedPermissionRecord2802', other],
    ]);
    const getAllClasses = vi
      .spyOn(ObjectRegistry, 'getAllClasses')
      .mockReturnValue(registrations);
    const getAllMetadata = vi
      .spyOn(ObjectRegistry, 'getAllObjectMetadata')
      .mockImplementation(() => {
        throw new Error('catalog must not project all object metadata');
      });
    const getRelationshipMap = vi
      .spyOn(ObjectRegistry, 'getRelationshipMap')
      .mockImplementation(() => {
        throw new Error('catalog must not project relationships');
      });

    const service = PermissionCatalogService.create();
    const first = service.getCatalog().permissions;
    const firstSlugs = first.map((permission) => permission.slug);
    expect(firstSlugs).toEqual(
      expect.arrayContaining([
        'catalog_a_2802.read',
        'catalog_a_2802.read.inherited',
        'catalog_a_2802.create',
        'catalog_a_2802.publish',
        'catalog_b_2802.read',
        'catalog_b_2802.delete',
        'catalog_b_2802.publish',
      ]),
    );
    expect(firstSlugs).not.toContain('catalog_a_2802.hidden');
    expect(
      firstSlugs.filter((slug) => slug === 'catalog_a_2802.read'),
    ).toHaveLength(1);
    expect(
      first.find((permission) => permission.slug === 'catalog_a_2802.read'),
    ).toMatchObject({ qualifiedName: '@catalog/a:SharedPermissionRecord2802' });
    expect(
      first.find((permission) => permission.slug === 'catalog_b_2802.read'),
    ).toMatchObject({ qualifiedName: '@catalog/b:SharedPermissionRecord2802' });
    expect(getAllMetadata).not.toHaveBeenCalled();
    expect(getRelationshipMap).not.toHaveBeenCalled();

    getAllClasses.mockReturnValue(
      new Map([['@catalog/b:SharedPermissionRecord2802', other]]),
    );
    const afterSnapshotChange = service
      .getCatalog()
      .permissions.map((permission) => permission.slug);
    expect(afterSnapshotChange).toContain('catalog_b_2802.read');
    expect(afterSnapshotChange).not.toContain('catalog_a_2802.read');
  });

  it('uses current qualified public registrations for colliding names and removes only its own fixtures', () => {
    // `getAllClasses()` intentionally returns a copy. Reach through this
    // test-only boundary solely to remove the fixtures this test registers;
    // catalog construction itself continues to use the public snapshot API.
    const classes = (
      ObjectRegistry as unknown as {
        classes: Map<string, { packageName?: string }>;
      }
    ).classes;
    const owned = new Set<object>();
    const register = (
      packageName: string,
      collection: string,
      include: string[],
    ) => {
      ObjectRegistry.registerFromManifest(
        `${packageName}:PermissionCatalogPeer2802`,
        {
          className: 'PermissionCatalogPeer2802',
          collection,
          decoratorConfig: {
            api: { include },
            mcp: { include: ['publish', 'hidden'] },
          },
          fields: {},
          methods: {},
        },
        packageName,
      );
      const registered = ObjectRegistry.getClassByQualifiedName(
        `${packageName}:PermissionCatalogPeer2802`,
      );
      if (!registered) throw new Error('expected registered catalog fixture');
      owned.add(registered);
      Object.assign(registered.config, {
        api: { include },
        collection,
        mcp: { include: ['publish', 'hidden'] },
      });
      registered.inheritedFields = new Map([
        [
          'visible',
          {
            _meta: { readPermission: `${collection}.read.inherited` },
            type: 'text',
          },
        ],
      ]);
      registered.methods.set('publish', { isPublic: true, name: 'publish' });
      registered.methods.set('hidden', { isPublic: false, name: 'hidden' });
      return registered;
    };

    try {
      const first = register('@catalog/integration-a', 'catalog_real_a_2802', [
        'list',
        'create',
      ]);
      const second = register('@catalog/integration-b', 'catalog_real_b_2802', [
        'list',
        'delete',
      ]);
      classes.set('PermissionCatalogPeer2802', first);

      const service = PermissionCatalogService.create();
      const initial = service.getCatalog().permissions;
      expect(initial.map((permission) => permission.slug)).toEqual(
        expect.arrayContaining([
          'catalog_real_a_2802.read',
          'catalog_real_a_2802.read.inherited',
          'catalog_real_a_2802.create',
          'catalog_real_a_2802.publish',
          'catalog_real_b_2802.read',
          'catalog_real_b_2802.read.inherited',
          'catalog_real_b_2802.delete',
          'catalog_real_b_2802.publish',
        ]),
      );
      expect(initial.map((permission) => permission.slug)).not.toContain(
        'catalog_real_a_2802.hidden',
      );
      expect(
        initial.find(
          (permission) => permission.slug === 'catalog_real_a_2802.read',
        ),
      ).toMatchObject({ qualifiedName: first.qualifiedName });
      expect(
        initial.find(
          (permission) => permission.slug === 'catalog_real_b_2802.read',
        ),
      ).toMatchObject({ qualifiedName: second.qualifiedName });

      for (const [key, registered] of classes) {
        if (registered.packageName === '@catalog/integration-a') {
          classes.delete(key);
        }
      }
      const afterRemoval = service
        .getCatalog()
        .permissions.map((permission) => permission.slug);
      expect(afterRemoval).toContain('catalog_real_b_2802.read');
      expect(afterRemoval).not.toContain('catalog_real_a_2802.read');

      register('@catalog/integration-c', 'catalog_real_c_2802', ['list']);
      expect(
        service.getCatalog().permissions.map((permission) => permission.slug),
      ).toContain('catalog_real_c_2802.read');
    } finally {
      for (const [key, registered] of classes) {
        if (owned.has(registered)) classes.delete(key);
      }
    }
  });

  it('should derive CRUD and exposed custom permissions from the manifest', () => {
    const catalog = PermissionCatalogService.create().getCatalog();
    const matchingSlugs = catalog.permissions
      .map((permission) => permission.slug)
      .filter((slug) => slug.startsWith('permission_catalog_records.'));

    expect(matchingSlugs).toContain('permission_catalog_records.read');
    expect(matchingSlugs).toContain('permission_catalog_records.read.internal');
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

  it('should include CLI and MCP custom methods when the transport is enabled without an include list', () => {
    const catalog = PermissionCatalogService.create().getCatalog();
    const matchingSlugs = catalog.permissions
      .map((permission) => permission.slug)
      .filter((slug) =>
        slug.startsWith('default_exposure_permission_catalog_records.'),
      );

    expect(matchingSlugs).toContain(
      'default_exposure_permission_catalog_records.summarize',
    );
    expect(matchingSlugs).not.toContain(
      'default_exposure_permission_catalog_records.hidden',
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

  it('should preserve unique Postgres policy names for long table names across actions', () => {
    const result = generatePostgresPermissionSql();
    const longTableStatements = result.statements.filter(
      (statement) =>
        statement.startsWith('CREATE POLICY') &&
        statement.includes(
          '"permission_policy_table_name_that_is_far_too_long_for_postgres_identifier_limits"',
        ),
    );
    const policyNames = longTableStatements
      .map((statement) => statement.match(/CREATE POLICY "([^"]+)"/)?.[1])
      .filter((name): name is string => Boolean(name));

    expect(policyNames).toHaveLength(4);
    expect(new Set(policyNames).size).toBe(4);
    expect(policyNames.some((name) => name.includes('_select_'))).toBe(true);
    expect(policyNames.some((name) => name.includes('_insert_'))).toBe(true);
    expect(policyNames.some((name) => name.includes('_update_'))).toBe(true);
    expect(policyNames.some((name) => name.includes('_delete_'))).toBe(true);
  });

  it('should reject invalid Postgres permission bindings from config', () => {
    setConfig({
      packages: {
        users: {
          permissions: {
            postgres: {
              bindings: [
                {
                  action: 'archive' as any,
                  permission: 'app.archive',
                  tableName: 'permission_catalog_records',
                },
              ],
            },
          },
        },
      },
    });

    expect(() => generatePostgresPermissionSql()).toThrow(
      /Invalid Postgres permission binding action/,
    );
  });
});
