import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { field } from '../decorators/index.js';
import * as generated from '../generated-fields.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator, getRuntimeManifest } from '../generators/rest.js';
import { generateOpenAPISpec } from '../generators/swagger.js';
import { SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import * as inheritance from '../registry/inheritance-resolver.js';
import {
  createFieldFromManifest,
  mergeManifestField,
} from '../registry/manifest-field-merge.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  planRuntimeModelDDL,
  registerRuntimeModel,
  runtimeModelEntry,
} from '../runtime-model.js';
import { checkLiveSchemaParity } from '../schema/live-parity.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

function plain(name: string, parent: typeof SmrtObject = SmrtObject) {
  const Model = class extends parent {};
  Object.defineProperty(Model, 'name', { value: name });
  field({ type: 'integer' })(Model.prototype, 'qty');
  return Model;
}

describe('generated feature isolation #4972 round5', () => {
  let restore: () => void;
  const databases: DatabaseInterface[] = [];
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    ObjectRegistry.clearDiagnostics();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) await db.close?.();
    restore();
  });

  it('plain models perform zero generated validations across registration and ordinary surfaces', async () => {
    const validate = vi.spyOn(generated, 'validateGeneratedFields');
    const registration = vi.spyOn(
      ObjectRegistry,
      'validateGeneratedRegistration',
    );
    const effective = vi.spyOn(inheritance, 'getEffectiveFieldsSync');
    const walk = vi.spyOn(ObjectRegistry, 'getInheritanceChain');
    const Parent = plain('PlainLateParent');
    const Child = plain('PlainLateChild', Parent);
    smrt({ packageName: '@test/plain-isolation' })(Child);
    smrt({ packageName: '@test/plain-isolation' })(Parent);
    const Root = plain('PlainSTIRoot');
    smrt({ packageName: '@test/plain-isolation', tableStrategy: 'sti' })(Root);
    const Middle = plain('PlainSTIMiddle', Root);
    smrt({ packageName: '@test/plain-isolation' })(Middle);
    const Leaf = plain('PlainSTILeaf', Middle);
    smrt({ packageName: '@test/plain-isolation' })(Leaf);
    for (let i = 0; i < 30; i++) {
      smrt({ packageName: '@test/plain-isolation' })(plain(`Plain${i}`));
      registerRuntimeModel({
        name: `RuntimePlain${i}`,
        packageName: '@test/plain-isolation',
        fields: { qty: { type: 'integer' } },
      });
    }
    expect(walk.mock.calls.filter(([, pending]) => pending)).toHaveLength(0);
    for (const [key] of ObjectRegistry.getAllClasses()) {
      expect(JSON.stringify(ObjectRegistry.getFields(key))).toBe('{}');
      await ObjectRegistry.getAllFields(key);
      ObjectRegistry.getSchema(key);
    }
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [],
      includeSystemTables: false,
    });
    databases.push(db);
    await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
    generateOpenAPISpec();
    expect(validate).not.toHaveBeenCalled();
    expect(registration).not.toHaveBeenCalled();
    expect(effective).not.toHaveBeenCalled();
  });

  it('ordinary live schemas do not perform generated declaration walks during diff or parity', async () => {
    const name = registerRuntimeModel({
      name: 'OrdinaryLive',
      packageName: '@test/ordinary-live',
      fields: { qty: { type: 'integer' } },
    });
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [name],
      includeSystemTables: false,
    });
    databases.push(db);
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    const originalSome = Array.prototype.some;
    let declarationWalks = 0;
    vi.spyOn(Array.prototype, 'some').mockImplementation(function (
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ): boolean {
      if (/\.generated\b/.test(Function.prototype.toString.call(predicate)))
        declarationWalks++;
      return Reflect.apply(originalSome, this, [predicate, thisArg]);
    });
    await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
    await checkLiveSchemaParity({
      db,
      schemas,
      engineHint: 'sqlite',
      includeSystemTables: false,
      reportExtraTables: false,
    });
    expect(declarationWalks).toBe(0);
  });

  it('plain manifest field policies retain the pre-PR own metadata shape', () => {
    // Expectations computed the pre-PR way: metadata bag plus required/default/description/enum only.
    const field = {
      type: 'text' as const,
      readonly: true,
      sensitive: true,
      readPermission: 'read.secret',
      transient: true,
      required: true,
      _meta: { description: 'kept' },
    };
    const expected = {
      type: 'text',
      _meta: { description: 'kept', required: true },
    };
    expect(createFieldFromManifest(field)).toEqual(expected);
    expect(mergeManifestField({ type: 'text', _meta: {} }, field)).toEqual(
      expected,
    );
  });

  it('transactional registry restoration preserves discovery and the generated census', () => {
    const Model = class RestoredOwner extends SmrtObject {};
    field({ type: 'text' })(Model.prototype, 'ownerSource');
    smrt({
      packageName: '@test/restored-generated',
      tenantScoped: { field: 'organizationId' },
    })(Model);
    const name = '@test/restored-generated:RestoredOwner';
    const validate = vi.spyOn(generated, 'validateGeneratedFields');
    ObjectRegistry.checkpointRegistrations([name])();
    expect(validate).not.toHaveBeenCalled();
    const incoming = runtimeModelEntry({
      name: 'RestoredOwner',
      packageName: '@test/restored-generated',
      fields: {
        ownerSource: { type: 'text' },
        organizationId: { type: 'text', generated: { col: 'ownerSource' } },
      },
    });
    incoming.decoratorConfig!.tenantScoped = { field: 'organizationId' };
    expect(() =>
      ObjectRegistry.registerFromManifest(
        name,
        incoming,
        '@test/restored-generated',
      ),
    ).toThrow(generated.GeneratedFieldError);

    const calculated = registerRuntimeModel({
      name: 'RestoredCalculation',
      packageName: '@test/restored-generated',
      fields: {
        qty: { type: 'integer' },
        total: { type: 'integer', generated: { col: 'qty' } },
      },
    });
    const rollback = ObjectRegistry.checkpointRegistrations([calculated]);
    ObjectRegistry.clear();
    rollback();
    expect(ObjectRegistry.getGeneratedClasses().get(calculated)).toBe(
      ObjectRegistry.getClass(calculated),
    );
    expect(() => ObjectRegistry.getFields(calculated)).not.toThrow();
  });

  it('registering plain classes never walks every existing uncached ancestry', () => {
    const walk = vi.spyOn(ObjectRegistry, 'getInheritanceChain');
    for (let i = 0; i < 80; i++) {
      walk.mockClear();
      smrt({ packageName: '@test/plain-cost' })(plain(`PlainCost${i}`));
      expect(walk.mock.calls.filter(([, pending]) => pending)).toHaveLength(0);
    }
  });

  it('quarantines only invalid and pending generated classes while their parent and the app remain usable', async () => {
    const Parent = plain('IsolatedParent');
    const Bad = class IsolatedBadChild extends Parent {};
    field({ type: 'text' })(Bad.prototype, 'ownerSource');
    field({ type: 'text', generated: { col: 'ownerSource' } })(
      Bad.prototype,
      'organizationId',
    );
    smrt({ packageName: '@test/mixed-isolation', tableName: 'isolated_bad' })(
      Bad,
    );
    const NeverParent = class NeverParent extends SmrtObject {};
    const Pending = class IsolatedPending extends NeverParent {};
    field({ type: 'integer' })(Pending.prototype, 'qty');
    field({ type: 'integer', generated: { col: 'qty' } })(
      Pending.prototype,
      'total',
    );
    smrt({
      packageName: '@test/mixed-isolation',
      tableName: 'isolated_pending',
    })(Pending);
    expect(() =>
      smrt({
        packageName: '@test/mixed-isolation',
        tableName: 'isolated_parent',
        tenantScoped: { field: 'organizationId' },
      })(Parent),
    ).not.toThrow();
    const good = registerRuntimeModel({
      name: 'IsolatedGood',
      packageName: '@test/mixed-isolation',
      fields: { qty: { type: 'integer' } },
    });
    const bad = '@test/mixed-isolation:IsolatedBadChild';
    const pending = '@test/mixed-isolation:IsolatedPending';
    const typed = expect.objectContaining({ name: 'GeneratedFieldError' });
    for (const key of [bad, pending]) {
      expect(() => ObjectRegistry.getFields(key)).toThrow(typed);
      await expect(ObjectRegistry.getAllFields(key)).rejects.toThrow(typed);
      await expect(
        planRuntimeModelDDL(key, 'sqlite', async () => null),
      ).rejects.toThrow(typed);
      expect(() => ObjectRegistry.getSchemaDDL(key, 'sqlite')).toThrow(typed);
    }
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['isolated_parent', 'isolated_goods']),
    );
    expect(schemas).not.toHaveProperty('isolated_bad');
    expect(schemas).not.toHaveProperty('isolated_pending');
    expect(schemas.isolated_parent.columns).not.toHaveProperty('owner_source');
    expect(
      ObjectRegistry.getCreateTargets('@test/mixed-isolation:IsolatedParent')
        .subtypes,
    ).toEqual([]);
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [],
      includeSystemTables: false,
    });
    databases.push(db);
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      schemas,
    );
    expect(diff.added_tables.map((schema) => schema.tableName)).toEqual(
      expect.arrayContaining(['isolated_parent', 'isolated_goods']),
    );
    const spec = generateOpenAPISpec() as unknown as {
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.components.schemas).toHaveProperty('IsolatedParent');
    expect(spec.components.schemas).toHaveProperty('IsolatedGood');
    expect(spec.components.schemas).not.toHaveProperty('IsolatedBadChild');
    expect(spec.components.schemas).not.toHaveProperty('IsolatedPending');
    await expect(new MCPGenerator().generateToolDefinitions()).resolves.toEqual(
      expect.any(Array),
    );
    for (const Ctor of [Bad, Pending])
      await expect(async () => new Ctor({ db }).save()).rejects.toThrow(typed);
    expect(Object.keys(getRuntimeManifest().objects)).not.toEqual(
      expect.arrayContaining([bad, pending]),
    );
    const api = new APIGenerator({ basePath: '/api' }, { db });
    for (const [key, Ctor] of [
      [bad, Bad],
      [pending, Pending],
    ] as const) {
      const info = ObjectRegistry.getClass(key)!;
      const response = await api.generateHandler()(
        new Request(`http://test/api/${info.collection}`),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('VALIDATION_GENERATED');
      const mcp = await new MCPGenerator({}, { db }).handleToolCall({
        method: 'tools/call',
        params: { name: `${Ctor.name.toLowerCase()}_list`, arguments: {} },
      });
      expect(mcp.isError).toBe(true);
      expect(JSON.stringify(mcp)).toContain('VALIDATION_GENERATED');
    }
    expect(ObjectRegistry.getFields(good).has('qty')).toBe(true);
    expect(ObjectRegistry.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^VALIDATION_GENERATED/),
          context: expect.objectContaining({ className: bad }),
        }),
        expect.objectContaining({
          code: expect.stringMatching(/^VALIDATION_GENERATED/),
          context: expect.objectContaining({ className: pending }),
        }),
      ]),
    );
  });
});
