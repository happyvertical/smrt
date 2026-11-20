/**
 * #5143: a same-named subtype (`replaceParent: false`) is supported only in a
 * family that declares no tenancy. Registration (constructor and manifest, in
 * either order) and manifest generation refuse a subtype whose family carries
 * tenancy anywhere, and refuse tenancy arriving on a family that already has
 * a registered subtype, with CONFIG_SAME_NAME_TENANCY_UNSUPPORTED. A family
 * with no tenancy, and differently named subclasses, are unaffected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators';
import { assertSameNameSubclassChoices } from '../../manifest/model-replacements';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';

const ROOT_PKG = '@fixture/t5143u-media';
const PARENT_PKG = '@fixture/t5143u-video';
const APP_PKG = '@fixture/t5143u-app';
const SUB_PKG = '@fixture/t5143u-histrio';
const ROOT = `${ROOT_PKG}:Record`;
const PARENT = `${PARENT_PKG}:Scene`;
const APP = `${APP_PKG}:Scene`;
const SUB = `${SUB_PKG}:Scene`;
const VIP = `${PARENT_PKG}:VipScene`;
const TABLE = 't5143u_records';
const CODE = 'CONFIG_SAME_NAME_TENANCY_UNSUPPORTED';

type Tenancy = unknown;
const tenancy = (value: Tenancy) =>
  value === undefined ? {} : { tenantScoped: value as never };
const registered = (key: string) => ObjectRegistry.getAllClasses().has(key);

function expectRefusal(
  register: () => void,
  subtype: string,
  owner?: string,
): void {
  let error: unknown;
  try {
    register();
  } catch (caught) {
    error = caught;
  }
  expect(error, 'expected a refusal').toMatchObject({
    code: CODE,
    details: { className: subtype, ...(owner ? { tenancyOwner: owner } : {}) },
  });
  expect(String((error as Error).message)).toMatch(
    /supported only in a family that declares no tenancy\. Give .* a class name of its own .* or declare replaceParent: true/,
  );
}

/** Root (differently named STI base) <- Scene <- {app replacement, subtype, VipScene}. */
function family() {
  class MediaRecord extends SmrtObject {
    title = '';
  }
  class VideoScene extends MediaRecord {}
  class AppScene extends VideoScene {}
  class HistrioScene extends VideoScene {}
  class VipScene extends VideoScene {}
  field({ type: 'text' })(MediaRecord.prototype, 'title');
  const shared = { tableName: TABLE, tableStrategy: 'sti' as const };
  return {
    HistrioScene,
    VideoScene,
    root: (tenantScoped?: Tenancy) =>
      ObjectRegistry.register(MediaRecord, {
        ...shared,
        name: 'Record',
        packageName: ROOT_PKG,
        ...tenancy(tenantScoped),
      }),
    parent: (tenantScoped?: Tenancy) =>
      ObjectRegistry.register(VideoScene, {
        ...shared,
        name: 'Scene',
        packageName: PARENT_PKG,
        ...tenancy(tenantScoped),
      }),
    app: (tenantScoped?: Tenancy) =>
      ObjectRegistry.register(AppScene, {
        name: 'Scene',
        packageName: APP_PKG,
        tableName: TABLE,
        replaceParent: true,
        ...tenancy(tenantScoped),
      }),
    sub: (tenantScoped?: Tenancy) =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: SUB_PKG,
        replaceParent: false,
        ...tenancy(tenantScoped),
      }),
    vip: () =>
      ObjectRegistry.register(VipScene, {
        name: 'VipScene',
        packageName: PARENT_PKG,
        tableName: TABLE,
      }),
  };
}

const TENANCY_VALUES = [
  ['required tenancy', { mode: 'required', field: 'organizationId' }],
  ['optional tenancy', { mode: 'optional', field: 'organizationId' }],
  ['tenantScoped: true', true],
  ['an unknown mode', { mode: 'sometimes', field: 'organizationId' }],
] as const;

const DECORATOR_CONFIG = {
  mode: 'required' as const,
  field: 'accountId',
  autoFilter: true,
  autoPopulate: true,
  allowSuperAdminBypass: false,
};

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('same-named subtype tenancy, constructor registration', () => {
  it.each(
    TENANCY_VALUES,
  )('refuses a subtype whose parent declares %s, leaving the parent as it was', (_label, value) => {
    const fixture = family();
    fixture.root();
    fixture.parent(value);
    const before =
      ObjectRegistry.getAllClasses().get(PARENT)?.tenantScopedConfig;
    expectRefusal(() => fixture.sub(), SUB, PARENT);
    expect(registered(SUB)).toBe(false);
    expect(
      ObjectRegistry.getAllClasses().get(PARENT)?.tenantScopedConfig,
    ).toEqual(before);
  });

  it.each(
    TENANCY_VALUES,
  )('refuses a subtype that declares %s itself under an unscoped family', (_label, value) => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    expectRefusal(() => fixture.sub(value), SUB, SUB);
    expect(registered(SUB)).toBe(false);
  });

  it('refuses a subtype whose differently named ancestor declares tenancy', () => {
    const fixture = family();
    fixture.root({ mode: 'optional', field: 'organizationId' });
    fixture.parent();
    expectRefusal(() => fixture.sub(), SUB, ROOT);
  });

  it('refuses a subtype whose parent was replaced by a replacement that declares tenancy', () => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    fixture.app({ field: 'organizationId' });
    expectRefusal(() => fixture.sub(), SUB, APP);
  });

  it('refuses the subtype of a parent and replacement on different ownership fields', () => {
    const fixture = family();
    fixture.root();
    fixture.parent({ mode: 'required', field: 'organizationId' });
    fixture.app({ mode: 'optional', field: 'accountId' });
    expectRefusal(() => fixture.sub(), SUB);
    expect(registered(SUB)).toBe(false);
  });

  it('refuses a subtype registered after a run-time tenancy override of its parent', () => {
    const fixture = family();
    fixture.root();
    fixture.parent({ mode: 'optional', field: 'organizationId' });
    ObjectRegistry.registerOverride(PARENT, { tenancy: { mode: 'required' } });
    expectRefusal(() => fixture.sub(), SUB, PARENT);
  });

  it('refuses a run-time tenancy override once a subtype is registered', () => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    fixture.sub();
    expectRefusal(
      () =>
        ObjectRegistry.registerOverride(PARENT, {
          tenancy: { mode: 'required' },
        }),
      SUB,
      PARENT,
    );
    expect(ObjectRegistry.getRuntimeOverride(PARENT)).toBeUndefined();
  });

  it('refuses a replacement that brings tenancy to a family with a subtype, leaving the parent effective', () => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    fixture.sub();
    expectRefusal(() => fixture.app({ field: 'organizationId' }), SUB, APP);
    expect(registered(PARENT)).toBe(true);
    expect(registered(APP)).toBe(false);
    expect(registered(SUB)).toBe(true);
  });

  it('refuses @TenantScoped() on a subtype applied after @smrt()', () => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    fixture.sub();
    expectRefusal(
      () =>
        ObjectRegistry.reconcileTenantScopedConfig(
          fixture.HistrioScene,
          DECORATOR_CONFIG,
        ),
      SUB,
      SUB,
    );
    expect(ObjectRegistry.getTenantScopedConfig(SUB)).toBeUndefined();
  });

  it('refuses @TenantScoped() on a subtype applied before @smrt()', () => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    ObjectRegistry.reconcileTenantScopedConfig(
      fixture.HistrioScene,
      DECORATOR_CONFIG,
    );
    expectRefusal(() => fixture.sub(), SUB, SUB);
    expect(registered(SUB)).toBe(false);
  });

  it('refuses @TenantScoped() on the parent once a subtype is registered', () => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    fixture.sub();
    expectRefusal(
      () =>
        ObjectRegistry.reconcileTenantScopedConfig(
          fixture.VideoScene,
          DECORATOR_CONFIG,
        ),
      SUB,
      PARENT,
    );
    expect(ObjectRegistry.getTenantScopedConfig(PARENT)).toBeUndefined();
  });

  it.each([
    'subtype-first',
    'replacement-first',
  ] as const)('registers a family that declares no tenancy (%s)', (order) => {
    const fixture = family();
    fixture.root();
    fixture.parent();
    if (order === 'subtype-first') {
      fixture.sub();
      fixture.app();
    } else {
      fixture.app();
      fixture.sub();
    }
    fixture.vip();
    for (const key of [APP, SUB, VIP]) expect(registered(key)).toBe(true);
    for (const key of [ROOT, PARENT, APP, SUB, VIP])
      expect(ObjectRegistry.getTenantScopedConfig(key)).toBeUndefined();
  });

  it('leaves a differently named subclass of a tenant-scoped parent unaffected', () => {
    const fixture = family();
    fixture.root();
    fixture.parent({ mode: 'required', field: 'organizationId' });
    fixture.vip();
    expect(registered(VIP)).toBe(true);
    expect(ObjectRegistry.getTenantScopedConfig(PARENT)).toMatchObject({
      field: 'organizationId',
      mode: 'required',
    });
  });
});

/** A manifest entry of the fixture family. */
function entry(
  key: string,
  options: {
    parent?: string;
    replaceParent?: boolean;
    tenantScoped?: Tenancy;
    tableName?: string;
    sti?: boolean;
    fields?: SmartObjectDefinition['fields'];
  } = {},
): SmartObjectDefinition {
  const packageName = key.slice(0, key.lastIndexOf(':'));
  const className = key.slice(key.lastIndexOf(':') + 1);
  const tableName = options.tableName ?? TABLE;
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: key as never,
    packageName,
    filePath: `src/${className}.ts`,
    collection: 'records',
    extends: options.parent
      ? options.parent.slice(options.parent.lastIndexOf(':') + 1)
      : 'SmrtObject',
    ...(options.parent ? { extendsQualified: options.parent } : {}),
    fields: options.fields ?? {},
    methods: {},
    decoratorConfig: {
      tableName,
      ...(options.sti ? { tableStrategy: 'sti' as const } : {}),
      ...(options.replaceParent === undefined
        ? {}
        : { replaceParent: options.replaceParent }),
      ...tenancy(options.tenantScoped),
    },
    schema: {
      tableName,
      ddl: '',
      columns: {},
      indexes: [],
      version: 'fixture',
    },
  };
}

const manifestFamily = {
  root: (tenantScoped?: Tenancy) => entry(ROOT, { sti: true, tenantScoped }),
  parent: (tenantScoped?: Tenancy) =>
    entry(PARENT, { parent: ROOT, sti: true, tenantScoped }),
  app: (tenantScoped?: Tenancy) =>
    entry(APP, { parent: PARENT, replaceParent: true, tenantScoped }),
  sub: (tenantScoped?: Tenancy) =>
    entry(SUB, { parent: PARENT, replaceParent: false, tenantScoped }),
};

const load = (definition: SmartObjectDefinition) => () =>
  ObjectRegistry.registerFromManifest(
    definition.qualifiedName as string,
    definition,
    definition.packageName,
  );

describe('same-named subtype tenancy, manifest registration', () => {
  it('refuses a subtype that arrives after its tenant-scoped parent', () => {
    load(manifestFamily.root())();
    load(manifestFamily.parent({ field: 'organizationId' }))();
    expectRefusal(load(manifestFamily.sub()), SUB, PARENT);
    expect(registered(SUB)).toBe(false);
  });

  it('refuses a tenant-scoped parent that arrives after its subtype', () => {
    load(manifestFamily.root())();
    load(manifestFamily.sub())();
    expectRefusal(
      load(manifestFamily.parent({ mode: 'optional', field: 'accountId' })),
      SUB,
      PARENT,
    );
    expect(registered(PARENT)).toBe(false);
  });

  it.each([
    'parent-first',
    'subtype-first',
  ] as const)('refuses a subtype entry that declares tenancy under an unscoped parent (%s)', (order) => {
    load(manifestFamily.root())();
    if (order === 'parent-first') load(manifestFamily.parent())();
    expectRefusal(
      load(manifestFamily.sub({ field: 'organizationId' })),
      SUB,
      SUB,
    );
    expect(registered(SUB)).toBe(false);
  });

  it('refuses a subtype whose parent entry declares an unknown tenancy mode', () => {
    load(manifestFamily.root())();
    load(
      manifestFamily.parent({ mode: 'sometimes', field: 'organizationId' }),
    )();
    expectRefusal(load(manifestFamily.sub()), SUB, PARENT);
  });

  it('refuses a subtype whose parent entry carries a tenant field', () => {
    load(manifestFamily.root())();
    load(
      entry(PARENT, {
        parent: ROOT,
        sti: true,
        fields: {
          organizationId: {
            type: 'text',
            _meta: { __tenancy: { isTenantIdField: true } },
          } as never,
        },
      }),
    )();
    expectRefusal(load(manifestFamily.sub()), SUB, PARENT);
  });

  it('refuses a subtype whose differently named ancestor entry declares tenancy', () => {
    load(manifestFamily.root({ field: 'organizationId' }))();
    load(manifestFamily.parent())();
    expectRefusal(load(manifestFamily.sub()), SUB, ROOT);
  });

  it('refuses a tenant-scoped ancestor entry that arrives after the subtype', () => {
    load(manifestFamily.parent())();
    load(manifestFamily.sub())();
    expectRefusal(
      load(manifestFamily.root({ field: 'organizationId' })),
      SUB,
      ROOT,
    );
    expect(registered(ROOT)).toBe(false);
  });

  it('refuses a tenant-scoped parent kept only as the declaration a replacement took over', () => {
    load(manifestFamily.root())();
    load(manifestFamily.app())();
    load(manifestFamily.sub())();
    expectRefusal(
      load(manifestFamily.parent({ field: 'organizationId' })),
      SUB,
      PARENT,
    );
  });

  it('refuses a replacement entry that brings tenancy to a family with a subtype', () => {
    load(manifestFamily.root())();
    load(manifestFamily.parent())();
    load(manifestFamily.sub())();
    expectRefusal(load(manifestFamily.app({ field: 'accountId' })), SUB, APP);
    expect(registered(PARENT)).toBe(true);
    expect(registered(APP)).toBe(false);
  });

  it.each([
    ['parent-first', ['root', 'parent', 'app', 'sub']],
    ['subtype-first', ['root', 'sub', 'app', 'parent']],
  ] as const)('registers a family that declares no tenancy (%s)', (_label, order) => {
    for (const member of order) load(manifestFamily[member]())();
    expect(registered(SUB)).toBe(true);
    expect(registered(APP)).toBe(true);
    for (const key of [ROOT, PARENT, APP, SUB])
      expect(ObjectRegistry.getTenantScopedConfig(key)).toBeUndefined();
  });
});

describe('same-named subtype tenancy, manifest generation', () => {
  const VIP_ENTRY = () => entry(VIP, { parent: PARENT });
  const manifest = (
    ...objects: SmartObjectDefinition[]
  ): SmartObjectManifest => ({
    version: '1',
    timestamp: 0,
    packageName: SUB_PKG,
    objects: Object.fromEntries(
      objects.map((object) => [object.qualifiedName as string, object]),
    ),
  });
  const refusedAt = (value: SmartObjectManifest, owner: string) =>
    expectRefusal(() => assertSameNameSubclassChoices(value), SUB, owner);

  it('refuses a subtype whose parent, ancestor or replacement declares tenancy', () => {
    const scoped = { mode: 'optional', field: 'organizationId' };
    const { root, parent, app, sub } = manifestFamily;
    refusedAt(manifest(root(), parent(scoped), sub()), PARENT);
    refusedAt(manifest(root(scoped), parent(), sub()), ROOT);
    refusedAt(manifest(root(), parent(), app(scoped), sub()), APP);
    refusedAt(
      manifest(root(), parent({ field: 'organizationId' }), app(scoped), sub()),
      PARENT,
    );
  });

  it('refuses a subtype that declares tenancy itself, with or without its parent in the manifest', () => {
    const { root, parent, sub } = manifestFamily;
    refusedAt(manifest(root(), parent(), sub(true)), SUB);
    refusedAt(manifest(sub({ field: 'organizationId' })), SUB);
  });

  it('counts an unknown mode and a tenant field as tenancy', () => {
    const { root, parent, sub } = manifestFamily;
    refusedAt(manifest(root(), parent({ mode: 'sometimes' }), sub()), PARENT);
    refusedAt(
      manifest(
        root(),
        entry(PARENT, {
          parent: ROOT,
          sti: true,
          fields: {
            organizationId: {
              type: 'text',
              _meta: { __tenancy: { isTenantIdField: true } },
            } as never,
          },
        }),
        sub(),
      ),
      PARENT,
    );
  });

  it('refuses a replacement of the subtype that declares tenancy', () => {
    const { root, parent, sub } = manifestFamily;
    const subReplacement = entry('@fixture/t5143u-later:Scene', {
      parent: SUB,
      replaceParent: true,
      tenantScoped: { field: 'organizationId' },
    });
    refusedAt(
      manifest(root(), parent(), sub(), subReplacement),
      '@fixture/t5143u-later:Scene',
    );
  });

  it('accepts a family with no tenancy, and a differently named subclass of a tenant-scoped parent', () => {
    const { root, parent, app, sub } = manifestFamily;
    expect(() =>
      assertSameNameSubclassChoices(
        manifest(root(), parent(), app(), sub(), VIP_ENTRY()),
      ),
    ).not.toThrow();
    expect(() =>
      assertSameNameSubclassChoices(
        manifest(root(), parent({ field: 'organizationId' }), VIP_ENTRY()),
      ),
    ).not.toThrow();
  });
});
