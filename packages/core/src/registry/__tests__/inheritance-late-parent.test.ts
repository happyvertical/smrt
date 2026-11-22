/**
 * A class whose chain is read while its parent is not yet registered holds
 * that parent-less shape only until the registry changes: once the parent
 * registers, the chain, merged fields, table strategy, STI base, tenant column
 * and conflict columns follow the full hierarchy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry';
import type { SmartObjectDefinition } from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';

const EVENTS = '@late-parent/events';
const APP = '@late-parent/app';
const PARENT = `${EVENTS}:LateParentEvent`;
const CHILD = `${APP}:LateParentMeeting`;

const manifests = vi.hoisted(() => ({
  byPackage: new Map<string, any>(),
}));

vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../manifest/manifest-loader.js')>();
  return {
    ...actual,
    loadExternalManifest: async (pkg: string, ...rest: any[]) =>
      manifests.byPackage.has(pkg)
        ? manifests.byPackage.get(pkg)
        : (actual.loadExternalManifest as any)(pkg, ...rest),
    discoverManifestEntry: async (...args: any[]) => {
      const key = String(args[1]);
      for (const manifest of manifests.byPackage.values()) {
        if (manifest?.objects?.[key]) return manifest.objects[key];
      }
      return (actual.discoverManifestEntry as any)(...args);
    },
  };
});

function parentDef(): SmartObjectDefinition {
  return {
    name: 'lateparentevent',
    className: 'LateParentEvent',
    packageName: EVENTS,
    collection: 'late_parent_events',
    filePath: `/${EVENTS}/src/event.ts`,
    fields: {
      title: { type: 'text' },
      tenantId: { type: 'text' },
      privateNote: { type: 'text', readPermission: 'late_parent_events.notes' },
    },
    methods: {},
    decoratorConfig: {
      tableStrategy: 'sti',
      tableName: 'late_parent_events',
      tenantScoped: true,
    },
  } as unknown as SmartObjectDefinition;
}

function childDef(): SmartObjectDefinition {
  return {
    name: 'lateparentmeeting',
    className: 'LateParentMeeting',
    packageName: APP,
    collection: 'late_parent_meetings',
    filePath: `/${APP}/src/meeting.ts`,
    fields: { room: { type: 'text' } },
    methods: {},
    extends: 'LateParentEvent',
    extendsQualified: PARENT,
    decoratorConfig: {},
  } as unknown as SmartObjectDefinition;
}

function setManifest(pkg: string, def: SmartObjectDefinition): void {
  manifests.byPackage.set(pkg, {
    packageName: pkg,
    version: '1.0.0',
    objects: { [`${pkg}:${def.className}`]: def },
  });
}

async function shape() {
  const fields = await ObjectRegistry.getAllFields(CHILD);
  return {
    chain: ObjectRegistry.getInheritanceChain(CHILD),
    fields: [...fields.keys()].filter((key) =>
      ['title', 'tenantId', 'room'].includes(key),
    ),
    strategy: ObjectRegistry.getTableStrategy(CHILD),
    stiBase: ObjectRegistry.getSTIBase(CHILD),
    tenantColumn: ObjectRegistry.getTenantColumn(CHILD),
    conflict: ObjectRegistry.getConflictColumns(CHILD),
  };
}

const FULL_SHAPE = {
  chain: [PARENT, CHILD],
  fields: ['title', 'tenantId', 'room'],
  strategy: 'sti',
  stiBase: PARENT,
  tenantColumn: 'tenant_id',
  conflict: ['tenant_id', 'slug', 'context', '_meta_type'],
};

describe('inheritance state after a parent registers late', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    manifests.byPackage.clear();
  });

  afterEach(() => {
    manifests.byPackage.clear();
    restore();
  });

  it('control: parent loaded first gives the full shape', async () => {
    setManifest(EVENTS, parentDef());
    setManifest(APP, childDef());
    await ObjectRegistry.tryLoadFromExternalPackage(PARENT);
    await ObjectRegistry.tryLoadFromExternalPackage(CHILD);
    expect(await shape()).toEqual(FULL_SHAPE);
  });

  it('a lazily loaded child read before its parent takes the full shape once the parent loads', async () => {
    manifests.byPackage.set(EVENTS, null);
    setManifest(APP, childDef());
    expect(await ObjectRegistry.tryLoadFromExternalPackage(CHILD)).toBe(true);
    const before = await shape();
    expect(before.chain).toEqual([CHILD]);
    expect(before.fields).toEqual(['room']);

    setManifest(EVENTS, parentDef());
    await ObjectRegistry.tryLoadFromExternalPackage(PARENT);
    expect(ObjectRegistry.hasClass(PARENT)).toBe(true);

    expect(await shape()).toEqual(FULL_SHAPE);
  });

  it('a manifest child read before its parent registers follows the parent', async () => {
    ObjectRegistry.registerFromManifest(CHILD, childDef(), APP);
    expect(ObjectRegistry.getInheritanceChain(CHILD)).toEqual([CHILD]);
    expect(ObjectRegistry.getTableStrategy(CHILD)).toBe('cti');

    ObjectRegistry.registerFromManifest(PARENT, parentDef(), EVENTS);

    expect(ObjectRegistry.getInheritanceChain(CHILD)).toEqual([PARENT, CHILD]);
    expect(ObjectRegistry.getTableStrategy(CHILD)).toBe('sti');
    expect(ObjectRegistry.getSTIBase(CHILD)).toBe(PARENT);
  });

  it('the child collection uses the parent table after a late parent', async () => {
    manifests.byPackage.set(EVENTS, null);
    setManifest(APP, childDef());
    await ObjectRegistry.tryLoadFromExternalPackage(CHILD);
    setManifest(EVENTS, parentDef());
    await ObjectRegistry.tryLoadFromExternalPackage(PARENT);

    const { getTestDatabase } = await import('../../testing/database.js');
    const db = await getTestDatabase({ classes: [PARENT, CHILD] });
    try {
      const tables = await db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'late_parent%' ORDER BY name",
      );
      expect(tables.rows.map((row: any) => row.name)).toEqual([
        'late_parent_events',
      ]);
      const collection: any = await ObjectRegistry.getCollection(CHILD, {
        db,
      });
      expect(collection.tableName).toBe('late_parent_events');
    } finally {
      await db.close?.();
    }
  });

  it('keeps a partial chain stable while the registry does not change', () => {
    ObjectRegistry.registerFromManifest(CHILD, childDef(), APP);
    const first = ObjectRegistry.getInheritanceChain(CHILD);
    expect(ObjectRegistry.getInheritanceChain(CHILD)).toBe(first);
  });

  it('invalidateAllInheritanceCaches clears stored chains', () => {
    ObjectRegistry.registerFromManifest(CHILD, childDef(), APP);
    ObjectRegistry.registerFromManifest(PARENT, parentDef(), EVENTS);
    expect(ObjectRegistry.getInheritanceChain(CHILD)).toEqual([PARENT, CHILD]);

    ObjectRegistry.invalidateAllInheritanceCaches();

    expect(ObjectRegistry.getClass(CHILD)?.inheritanceChain).toBeUndefined();
    expect(ObjectRegistry.getInheritanceChain(CHILD)).toEqual([PARENT, CHILD]);
  });

  it('the same object and collection switch to the parent table once the parent loads', async () => {
    manifests.byPackage.set(EVENTS, null);
    setManifest(APP, childDef());
    await ObjectRegistry.tryLoadFromExternalPackage(CHILD);

    const { getTestDatabase } = await import('../../testing/database.js');
    const db = await getTestDatabase({ classes: [] });
    try {
      const collection: any = await ObjectRegistry.getCollection(CHILD, {
        db,
      });
      const Ctor = ObjectRegistry.getClass(CHILD)?.constructor as any;
      const object = new Ctor({ db });
      expect(collection.tableName).toBe('late_parent_meetings');
      expect(object.tableName).toBe('late_parent_meetings');

      setManifest(EVENTS, parentDef());
      await ObjectRegistry.tryLoadFromExternalPackage(PARENT);

      expect(collection.tableName).toBe('late_parent_events');
      expect(object.tableName).toBe('late_parent_events');
    } finally {
      await db.close?.();
    }
  });

  it('synchronous field readers see the parent fields as the first read after it registers', async () => {
    ObjectRegistry.registerFromManifest(CHILD, childDef(), APP);
    // Derive (and cache) the parent-less field set first.
    await ObjectRegistry.getAllFields(CHILD);
    const { restFieldReadPermissions } = await import(
      '../../generators/preflight-route.js'
    );
    expect(restFieldReadPermissions(CHILD)).toEqual([]);

    ObjectRegistry.registerFromManifest(PARENT, parentDef(), EVENTS);

    expect(restFieldReadPermissions(CHILD)).toEqual([
      'late_parent_events.notes',
    ]);
    expect([
      ...(ObjectRegistry.getClass(CHILD)?.inheritedFields?.keys() ?? []),
    ]).toEqual(expect.arrayContaining(['title', 'privateNote', 'room']));
  });

  it('a parent registered by the @smrt decorator also completes the chain', async () => {
    ObjectRegistry.registerFromManifest('LateDecoratedChild', {
      ...childDef(),
      name: 'latedecoratedchild',
      className: 'LateDecoratedChild',
      qualifiedName: undefined,
      packageName: undefined,
      extends: 'LateDecoratedParent',
      extendsQualified: undefined,
    } as unknown as SmartObjectDefinition);
    expect(ObjectRegistry.getInheritanceChain('LateDecoratedChild')).toEqual([
      'LateDecoratedChild',
    ]);
    await ObjectRegistry.getAllFields('LateDecoratedChild');

    const { smrt } = await import('../../registry');
    const { SmrtObject } = await import('../../object');
    const { field } = await import('../../decorators');
    @smrt({ tableName: 'late_decorated_parents' })
    class LateDecoratedParent extends SmrtObject {
      @field({ type: 'text' }) headline = '';
    }
    expect(
      ObjectRegistry.getClassByConstructor(LateDecoratedParent),
    ).toBeTruthy();

    const chain = ObjectRegistry.getInheritanceChain('LateDecoratedChild');
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatch(/(^|:)LateDecoratedParent$/);
    expect(chain[1]).toBe('LateDecoratedChild');
    expect(
      ObjectRegistry.getClass('LateDecoratedChild')?.inheritedFields?.has(
        'headline',
      ),
    ).toBe(true);
  });

  it('a link that resolved to the class itself is not kept as a complete chain', async () => {
    // Only the same-named child is registered, so its simple `extends`
    // resolves to itself: its real parent is missing.
    ObjectRegistry.registerFromManifest(
      `${APP}:LateSelfNamed`,
      {
        ...childDef(),
        name: 'lateselfnamed',
        className: 'LateSelfNamed',
        qualifiedName: `${APP}:LateSelfNamed`,
        extends: 'LateSelfNamed',
        extendsQualified: undefined,
      } as unknown as SmartObjectDefinition,
      APP,
    );
    expect(ObjectRegistry.getInheritanceChain(`${APP}:LateSelfNamed`)).toEqual([
      `${APP}:LateSelfNamed`,
    ]);

    const { getInheritanceCache } = await import('../shared-state');
    expect(getInheritanceCache().get(`${APP}:LateSelfNamed`)).toBeUndefined();
  });

  it('a chain read through a second copy of the resolver still follows a late parent', async () => {
    ObjectRegistry.registerFromManifest(CHILD, childDef(), APP);
    expect(ObjectRegistry.getInheritanceChain(CHILD)).toEqual([CHILD]);

    // A second loaded copy of core shares the registry entries and caches
    // through globalThis but has its own module state.
    vi.resetModules();
    const secondCopy = await import('../inheritance-resolver');
    expect(secondCopy.getInheritanceChain(CHILD)).toEqual([CHILD]);

    ObjectRegistry.registerFromManifest(PARENT, parentDef(), EVENTS);

    expect(ObjectRegistry.getInheritanceChain(CHILD)).toEqual([PARENT, CHILD]);
    expect(secondCopy.getInheritanceChain(CHILD)).toEqual([PARENT, CHILD]);
  });
});
