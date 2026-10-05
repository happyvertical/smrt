/**
 * #3490: an STI create resolves the selected subtype by its exact registry
 * identity. Two packages register a same-named subtype (`Variant`) of one
 * exposed base; a create naming either qualified `_meta_type` must construct
 * that package's subtype, through its own collection and write policy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { MCPGenerator } from './mcp.js';

function named<T extends typeof SmrtObject>(ctor: T, name: string): T {
  Object.defineProperty(ctor, 'name', { value: name });
  return ctor;
}

const created: Array<{ by: string; data: Record<string, unknown> }> = [];

/** A collection that records which subtype's collection a create reached. */
function recordingCollection(label: string, item: typeof SmrtObject) {
  return class extends SmrtCollection<SmrtObject> {
    static readonly _itemClass = item;
    async initialize() {
      return this;
    }
    async create(data: Record<string, unknown>) {
      created.push({ by: label, data: { ...data } });
      return {
        save: async () => undefined,
        toPublicJSON: () => ({ createdBy: label }),
      } as never;
    }
  };
}

const BASE = '@fixture/shapes3490:StiShape';
const VARIANT_A = '@fixture/pkg-a3490:Variant';
const VARIANT_B = '@fixture/pkg-b3490:Variant';

describe('MCP STI create across same-named subtypes (#3490)', () => {
  const StiShape = named(class extends SmrtObject {}, 'StiShape');
  const VariantA = named(class extends StiShape {}, 'Variant');
  const VariantB = named(class extends StiShape {}, 'Variant');
  let restoreRegistry: () => void;
  const user = { id: 'test-user' };

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.register(StiShape, {
      packageName: '@fixture/shapes3490',
      tableName: 'sti_shapes',
      tableStrategy: 'sti',
      mcp: { include: ['create'] },
    });
    ObjectRegistry.register(VariantA, {
      packageName: '@fixture/pkg-a3490',
      tableName: 'sti_shapes',
      api: { writable: ['alpha'] },
    });
    ObjectRegistry.register(VariantB, {
      packageName: '@fixture/pkg-b3490',
      tableName: 'sti_shapes',
      api: { writable: ['beta'] },
    });
    ObjectRegistry.registerCollection(
      BASE,
      recordingCollection('base', StiShape),
    );
    ObjectRegistry.registerCollection(
      VARIANT_A,
      recordingCollection('a', VariantA),
    );
    ObjectRegistry.registerCollection(
      VARIANT_B,
      recordingCollection('b', VariantB),
    );
  });

  afterAll(() => restoreRegistry());

  it('registers both subtypes under their own packages', () => {
    expect(ObjectRegistry.getClassByConstructor(VariantA)?.qualifiedName).toBe(
      VARIANT_A,
    );
    expect(ObjectRegistry.getClassByConstructor(VariantB)?.qualifiedName).toBe(
      VARIANT_B,
    );
  });

  it('advertises both discriminators with each subtype bound to its own identity', async () => {
    const [tool] = await new MCPGenerator({
      classNames: [BASE],
    }).generateTools();
    const variants = ((tool.inputSchema.oneOf ?? []) as unknown[])
      .map(
        (entry) =>
          (entry as { properties?: { _meta_type?: { const?: string } } })
            .properties?._meta_type?.const,
      )
      .filter(Boolean);
    expect(variants).toEqual(
      expect.arrayContaining([BASE, VARIANT_A, VARIANT_B]),
    );
  });

  it.each([
    [VARIANT_A, 'a', { alpha: 'x' }],
    [VARIANT_B, 'b', { beta: 'y' }],
  ])('creates %s through that subtype only', async (metaType, label, kept) => {
    created.length = 0;
    const response = await new MCPGenerator(
      { classNames: [BASE] },
      { user },
    ).handleToolCall({
      method: 'tools/call',
      params: {
        name: 'stishape_create',
        arguments: { _meta_type: metaType, alpha: 'x', beta: 'y' },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].by).toBe(label);
    // The subtype's own write policy applied: only its field survives.
    expect(created[0].data).toMatchObject(kept);
    expect(Object.keys(created[0].data)).not.toContain(
      label === 'a' ? 'beta' : 'alpha',
    );
  });
});
