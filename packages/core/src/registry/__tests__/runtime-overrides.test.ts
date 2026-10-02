import { afterEach, describe, expect, it } from 'vitest';
import { MCPGenerator } from '../../generators/mcp';
import { isApiActionEnabledForObject } from '../../generators/preflight-route';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import type { SmartObjectDefinition } from '../../scanner/types.js';

const key = '@fixture/runtime:OverrideRecord';
const closed = {
  api: false,
  mcp: false,
  cli: false,
  tenancy: { mode: 'required' },
} as const;
function model() {
  return class OverrideRecord extends SmrtObject {
    tenantId = '';
  };
}
function entry(
  pkg = '@fixture/runtime',
  parent = 'SmrtObject',
): SmartObjectDefinition {
  return {
    name: 'overriderecord',
    className: 'OverrideRecord',
    packageName: pkg,
    extends: parent,
    filePath: `${pkg}/model.ts`,
    fields: { tenantId: { type: 'text' } },
    methods: {},
    decoratorConfig: {
      tableName: 'override_records',
      api: true,
      mcp: true,
      cli: true,
      tenantScoped: { mode: 'optional' },
    },
    schema: {
      tableName: 'override_records',
      ddl: '',
      columns: { tenant_id: { type: 'TEXT' } },
      indexes: [],
      version: 'test',
    },
  } as SmartObjectDefinition;
}
afterEach(() => ObjectRegistry.clear());

describe('consumer runtime overrides', () => {
  for (const path of ['runtime', 'manifest'] as const) {
    it(`closes every generated operation without a second registration (${path})`, async () => {
      const ctor = model();
      if (path === 'runtime')
        ObjectRegistry.register(ctor, {
          packageName: '@fixture/runtime',
          tableName: 'override_records',
          api: true,
          cli: true,
          mcp: true,
          tenantScoped: { mode: 'optional' },
        });
      else ObjectRegistry.registerFromManifest(key, entry());
      const before = ObjectRegistry.getClass(key);
      const count = ObjectRegistry.getAllClasses().size;
      ObjectRegistry.registerOverride(key, closed);
      expect(ObjectRegistry.getClass(key)).toBe(before);
      expect(ObjectRegistry.getAllClasses().size).toBe(count);
      for (const operation of [
        'list',
        'get',
        'create',
        'update',
        'delete',
        'customAction',
      ] as const)
        expect(isApiActionEnabledForObject(key, operation)).toBe(false);
      expect(ObjectRegistry.getClass(key)?.config.cli).toBe(false);
      expect(
        (await new MCPGenerator().generateTools()).some((tool) =>
          tool.name.startsWith('overriderecord_'),
        ),
      ).toBe(false);
      expect(ObjectRegistry.getTenantScopedConfig(key)?.mode).toBe('required');
      const current = ObjectRegistry.getClass(key);
      const tenancy = ObjectRegistry.getTenantScopedConfig(key);
      if (current && tenancy) {
        ObjectRegistry.reconcileTenantScopedConfig(current.constructor, {
          ...tenancy,
          mode: 'optional',
        });
      }
      expect(ObjectRegistry.getTenantScopedConfig(key)?.mode).toBe('required');
      ObjectRegistry.registerFromManifest(key, entry());
      ObjectRegistry.register(ctor, {
        packageName: '@fixture/runtime',
        api: true,
        cli: true,
        mcp: true,
        tenantScoped: { mode: 'optional' },
      });
      ObjectRegistry.registerOverride(key, { api: { include: [] } });
      expect(ObjectRegistry.getClass(key)?.config).toMatchObject({
        api: false,
        cli: false,
        mcp: false,
      });
      expect(ObjectRegistry.getTenantScopedConfig(key)?.mode).toBe('required');
    });
  }

  for (const path of ['runtime', 'manifest'] as const) {
    it(`carries restrictions to a late same-named subtype (${path})`, () => {
      const Base = model();
      if (path === 'runtime')
        ObjectRegistry.register(Base, {
          packageName: '@fixture/runtime',
          tableName: 'override_records',
          tenantScoped: { mode: 'optional' },
        });
      else ObjectRegistry.registerFromManifest(key, entry());
      ObjectRegistry.registerOverride(key, closed);
      if (path === 'runtime') {
        const Child = class OverrideRecord extends Base {};
        ObjectRegistry.register(Child, {
          packageName: '@fixture/consumer',
          tableName: 'override_records',
          api: true,
          cli: true,
          mcp: true,
          tenantScoped: { mode: 'optional' },
        });
      } else
        ObjectRegistry.registerFromManifest(
          '@fixture/consumer:OverrideRecord',
          entry('@fixture/consumer', key),
        );
      expect(ObjectRegistry.getAllClasses().size).toBe(1);
      expect(
        ObjectRegistry.getClass('@fixture/consumer:OverrideRecord')?.config,
      ).toMatchObject({ api: false, mcp: false, cli: false });
      expect(
        ObjectRegistry.getTenantScopedConfig('@fixture/consumer:OverrideRecord')
          ?.mode,
      ).toBe('required');
    });
  }

  it('validates malformed policies atomically and refuses unqualified/unknown names', () => {
    ObjectRegistry.registerFromManifest(key, entry());
    for (const policy of [
      null,
      [],
      { api: true },
      { api: { include: ['list'] } },
      { api: false, tenancy: { mode: 'optional' } },
      { api: false, surprise: false },
      { tenancy: { mode: 'required', field: 'ownerId' } },
    ]) {
      expect(() =>
        ObjectRegistry.registerOverride(key, policy as never),
      ).toThrow();
      expect(ObjectRegistry.getClass(key)?.config.api).toBe(true);
      expect(ObjectRegistry.getRuntimeOverride(key)).toBeUndefined();
    }
    expect(() =>
      ObjectRegistry.registerOverride('OverrideRecord', closed),
    ).toThrow();
    expect(() =>
      ObjectRegistry.registerOverride('@missing:OverrideRecord', closed),
    ).toThrow();
    ObjectRegistry.registerOverride(key, closed);
    expect(Object.isFrozen(ObjectRegistry.getRuntimeOverride(key))).toBe(true);
    ObjectRegistry.clear();
    expect(ObjectRegistry.getRuntimeOverride(key)).toBeUndefined();
  });

  it('does not create tenancy or affect an unrelated same-named package', () => {
    ObjectRegistry.registerFromManifest(key, entry());
    const peer = entry('@fixture/peer');
    peer.decoratorConfig = {
      ...peer.decoratorConfig,
      tableName: 'peer_records',
      tenantScoped: false,
    };
    if (peer.schema) peer.schema.tableName = 'peer_records';
    ObjectRegistry.registerFromManifest('@fixture/peer:OverrideRecord', peer);
    expect(() =>
      ObjectRegistry.registerOverride('@fixture/peer:OverrideRecord', closed),
    ).toThrow();
    ObjectRegistry.registerOverride(key, closed);
    expect(
      ObjectRegistry.getClass('@fixture/peer:OverrideRecord')?.config.api,
    ).toBe(true);
  });
});

describe('N-level same-table subtype replacement', () => {
  it('uses the deepest runtime constructor across four packages and parent replay', () => {
    const Base = model();
    const Second = class OverrideRecord extends Base {};
    const Third = class OverrideRecord extends Second {};
    const Fourth = class OverrideRecord extends Third {};
    const constructors = [Base, Second, Third, Fourth];
    constructors.forEach((ctor, index) => {
      ObjectRegistry.register(ctor, {
        packageName: `@fixture/level${index}`,
        tableName: 'override_records',
        tenantScoped: { mode: index === 3 ? 'required' : 'optional' },
      });
    });
    constructors.slice(0, 3).forEach((ctor, index) => {
      ObjectRegistry.register(ctor, {
        packageName: `@fixture/level${index}`,
        tableName: 'override_records',
      });
    });
    expect(ObjectRegistry.getAllClasses().size).toBe(1);
    expect(
      ObjectRegistry.getClass('@fixture/level3:OverrideRecord')?.constructor,
    ).toBe(Fourth);
    expect(
      ObjectRegistry.getTenantScopedConfig('@fixture/level3:OverrideRecord')
        ?.mode,
    ).toBe('required');
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'override_records',
    ]);
  });

  for (const order of [
    [3, 0, 1, 2],
    [2, 0, 3, 1],
    [3, 2, 1, 0],
  ]) {
    it(`resolves manifests arriving in order ${order.join(',')}`, () => {
      for (const level of order)
        ObjectRegistry.registerFromManifest(
          `@fixture/level${level}:OverrideRecord`,
          entry(
            `@fixture/level${level}`,
            level ? `@fixture/level${level - 1}:OverrideRecord` : 'SmrtObject',
          ),
        );
      expect(ObjectRegistry.getAllClasses().size).toBe(1);
      expect(
        ObjectRegistry.getClass('@fixture/level3:OverrideRecord'),
      ).toBeDefined();
      expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
        'override_records',
      ]);
    });
  }

  for (const path of ['runtime', 'manifest'] as const) {
    it(`refuses sibling subtypes on one table (${path})`, () => {
      if (path === 'runtime') {
        const Base = model();
        const Left = class OverrideRecord extends Base {};
        const Right = class OverrideRecord extends Base {};
        [Base, Left, Right].forEach((ctor, index) => {
          ObjectRegistry.register(ctor, {
            packageName: `@fixture/branch${index}`,
            tableName: 'override_records',
          });
        });
      } else {
        for (let index = 0; index < 3; index++) {
          ObjectRegistry.registerFromManifest(
            `@fixture/branch${index}:OverrideRecord`,
            entry(
              `@fixture/branch${index}`,
              index ? '@fixture/branch0:OverrideRecord' : 'SmrtObject',
            ),
          );
        }
      }
      expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
        /unrelated classes/,
      );
    });
  }

  it('keeps a same-named runtime subclass whose isolated manifest declares another table', () => {
    const Base = model();
    ObjectRegistry.register(Base, {
      packageName: '@fixture/runtime',
      tableName: 'override_records',
    });
    const Child = class OverrideRecord extends Base {};
    const childKey = '@fixture/separate:OverrideRecord';
    const definition = entry('@fixture/separate', key);
    definition.decoratorConfig = {
      ...definition.decoratorConfig,
      tableName: 'separate_records',
    };
    if (definition.schema) definition.schema.tableName = 'separate_records';
    ObjectRegistry.register(Child, {
      packageName: '@fixture/separate',
      _manifestKey: childKey,
      _manifest: {
        version: '1.0.0',
        timestamp: 0,
        packageName: '@fixture/separate',
        objects: { [childKey]: definition },
      },
    });
    expect(ObjectRegistry.getClass(key)?.constructor).toBe(Base);
    expect(ObjectRegistry.getClass(childKey)?.constructor).toBe(Child);
    expect(ObjectRegistry.getTableName(key)).toBe('override_records');
    expect(ObjectRegistry.getTableName(childKey)).toBe('separate_records');
  });

  for (const [packageName, restrictParent] of [
    ['@fixture/isolated', false],
    ['@fixture/isolated', true],
    ['@fixture/runtime', false],
  ] as const) {
    it(`loads a same-table isolated subtype manifest and retains parent restrictions (${packageName}, ${restrictParent})`, () => {
      const Base = model();
      ObjectRegistry.register(Base, {
        packageName: '@fixture/runtime',
        tableName: 'override_records',
        api: true,
        cli: true,
        mcp: true,
        tenantScoped: { mode: 'optional' },
      });
      if (restrictParent) ObjectRegistry.registerOverride(key, closed);
      const Child = class OverrideRecord extends Base {};
      const childKey = `${packageName}:OverrideRecord`;
      const definition = entry(packageName, key);
      definition.fields.childValue = { type: 'text' };
      definition.methods.childAction = {
        name: 'childAction',
        parameters: [],
        returnType: 'void',
      };
      definition.schema!.columns.child_value = { type: 'TEXT' };
      definition.schema!.version = 'child-schema';
      if (!restrictParent)
        definition.decoratorConfig = {
          ...definition.decoratorConfig,
          api: false,
          cli: false,
          mcp: false,
          tenantScoped: { mode: 'required' },
        };
      ObjectRegistry.register(Child, {
        packageName,
        _manifestKey: childKey,
        _manifest: {
          version: '1.0.0',
          timestamp: 0,
          packageName,
          objects: { [childKey]: definition },
        },
      });
      const registered = ObjectRegistry.getClass(childKey)!;
      expect(registered.fields.has('childValue')).toBe(true);
      expect(registered.methods.has('childAction')).toBe(true);
      expect(registered.schema?.columns.child_value).toBeDefined();
      expect(registered.schema?.version).toBe('child-schema');
      expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
        'override_records',
      ]);
      expect(registered.config.api).toBe(false);
      expect(registered.config.cli).toBe(false);
      expect(registered.config.mcp).toBe(false);
      expect(registered.tenantScopedConfig?.mode).toBe('required');
      expect(ObjectRegistry.getAllClasses().size).toBe(1);
      ObjectRegistry.register(Base, {
        packageName: '@fixture/runtime',
        tableName: 'override_records',
      });
      expect(ObjectRegistry.getAllClasses().size).toBe(1);
      expect(ObjectRegistry.getClass(childKey)?.constructor).toBe(Child);
      if (restrictParent)
        expect(ObjectRegistry.getRuntimeOverride(childKey)?.tenancy?.mode).toBe(
          'required',
        );
    });
  }

  it('rejects a cyclic qualified replacement chain', () => {
    ObjectRegistry.registerFromManifest(
      '@fixture/left:OverrideRecord',
      entry('@fixture/left', '@fixture/right:OverrideRecord'),
    );
    expect(() =>
      ObjectRegistry.registerFromManifest(
        '@fixture/right:OverrideRecord',
        entry('@fixture/right', '@fixture/left:OverrideRecord'),
      ),
    ).toThrow(/ircular/);
  });

  it('retains manifest ancestry when replaying any parent of a four-level chain', () => {
    for (let level = 0; level < 4; level++)
      ObjectRegistry.registerFromManifest(
        `@fixture/level${level}:OverrideRecord`,
        entry(
          `@fixture/level${level}`,
          level ? `@fixture/level${level - 1}:OverrideRecord` : 'SmrtObject',
        ),
      );
    for (let level = 0; level < 3; level++)
      ObjectRegistry.registerFromManifest(
        `@fixture/level${level}:OverrideRecord`,
        entry(
          `@fixture/level${level}`,
          level ? `@fixture/level${level - 1}:OverrideRecord` : 'SmrtObject',
        ),
      );
    expect(ObjectRegistry.getAllClasses().size).toBe(1);
    expect(
      ObjectRegistry.getClass('@fixture/level3:OverrideRecord'),
    ).toBeDefined();
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'override_records',
    ]);
  });
});
