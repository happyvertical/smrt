/**
 * #5143: a package manifest registers whole or not at all. Every entry and
 * the package's table retirements are checked against the registry before the
 * first entry registers, so a refused package leaves the registry, its
 * policies, its discovery state and the manifest cache as they were.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache } from '../../manifest/manifest-loader';
import { getManifestCache } from '../../manifest/store';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';

const VIDEO = '@fixture/video';
const HISTRIO = '@fixture/histrio';
const OTHER = '@fixture/other';
const BASE = `${VIDEO}:Scene`;
const SUB = `${HISTRIO}:Scene`;
const CLIP = `${HISTRIO}:Clip`;
const REEL = `${OTHER}:Reel`;

const entry = (
  pkg: string,
  className: string,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition =>
  ({
    name: className.toLowerCase(),
    collection: `${className.toLowerCase()}s`,
    className,
    qualifiedName: `${pkg}:${className}`,
    packageName: pkg,
    filePath: `src/models/${className.toLowerCase()}.ts`,
    fields: { title: { type: 'text', _meta: {} } },
    methods: {},
    decoratorConfig: {},
    ...extra,
  }) as SmartObjectDefinition;

/** The provider's `Scene`, single-table so a same-named subclass may replace it. */
function registerBase(): void {
  ObjectRegistry.registerFromManifest(
    BASE,
    entry(VIDEO, 'Scene', { decoratorConfig: { tableStrategy: 'sti' } }),
    VIDEO,
  );
}

const subScene = (replaceParent: boolean | undefined) =>
  entry(HISTRIO, 'Scene', {
    extends: 'Scene',
    extendsQualified: BASE,
    decoratorConfig: {
      tableStrategy: 'sti',
      ...(replaceParent === undefined ? {} : { replaceParent }),
    },
  });

const packageOf = (
  objects: Record<string, SmartObjectDefinition>,
  extra: Partial<SmartObjectManifest> = {},
): SmartObjectManifest => ({
  version: '1',
  timestamp: 0,
  packageName: HISTRIO,
  objects,
  ...extra,
});

const UNDECLARED = expect.objectContaining({
  code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
});

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => {
  clearManifestCache();
  restore();
});

describe('a package manifest refused part-way', () => {
  it('registers no model it discovers from another package, and loads them on a corrected retry', () => {
    registerBase();
    // Another installed package declares a model on the same table as `Clip`:
    // registering `Clip` would discover and register it.
    getManifestCache().set(
      OTHER,
      packageOf(
        { [REEL]: entry(OTHER, 'Reel', { collection: 'clips' }) },
        { packageName: OTHER },
      ),
    );
    const clip = entry(HISTRIO, 'Clip', { collection: 'clips' });
    const keys = () => [...ObjectRegistry.getAllClasses().keys()].sort();
    const before = keys();
    expect(() =>
      ObjectRegistry.registerPackageManifest(
        packageOf({ [CLIP]: clip, [SUB]: subScene(undefined) }),
      ),
    ).toThrow(UNDECLARED);
    expect(keys()).toEqual(before);
    expect(ObjectRegistry.getClass(REEL)).toBeUndefined();
    expect(ObjectRegistry.getClass(CLIP)).toBeUndefined();
    expect(getManifestCache().has(HISTRIO)).toBe(false);

    ObjectRegistry.registerPackageManifest(
      packageOf({ [CLIP]: clip, [SUB]: subScene(true) }),
    );
    expect(ObjectRegistry.getClass(CLIP)?.qualifiedName).toBe(CLIP);
    expect(ObjectRegistry.getClass(REEL)?.qualifiedName).toBe(REEL);
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(SUB);
  });

  it('registers none of its models when its table retirements name a package it does not depend on', () => {
    registerBase();
    const before = [...ObjectRegistry.getAllClasses().keys()].sort();
    const retired = {
      packageName: '@fixture/outside',
      table: 'old_clips',
      lastOwner: '@fixture/outside:Old',
      since: '1.2.3',
      reason: 'Folded into another table.',
      rows: 'discard',
      definitions: [
        {
          release: '1.2.2',
          columns: { id: { type: 'UUID', referenceKind: 'id' } },
        },
      ],
    };
    const manifest = packageOf(
      { [CLIP]: entry(HISTRIO, 'Clip') },
      { retiredTables: [retired] as never },
    );
    expect(() => ObjectRegistry.registerPackageManifest(manifest)).toThrow(
      /Retired table old_clips/,
    );
    expect([...ObjectRegistry.getAllClasses().keys()].sort()).toEqual(before);
    expect(ObjectRegistry.getClass(CLIP)).toBeUndefined();
    expect(getManifestCache().has(HISTRIO)).toBe(false);
    // The same package without the outside entry registers.
    ObjectRegistry.registerPackageManifest(
      packageOf({ [CLIP]: entry(HISTRIO, 'Clip') }),
    );
    expect(ObjectRegistry.getClass(CLIP)?.qualifiedName).toBe(CLIP);
  });

  it("keeps a live model's table when a later entry of the package is refused", () => {
    class Widget extends SmrtObject {
      title = '';
    }
    smrt({ packageName: HISTRIO, tableName: 'widgets' })(Widget);
    const WIDGET = `${HISTRIO}:Widget`;
    registerBase();
    expect(ObjectRegistry.getClass(WIDGET)?.schema?.tableName).toBe('widgets');
    // A partial entry: an explicit table and no schema.
    const partial = entry(HISTRIO, 'Widget', {
      decoratorConfig: { tableName: 'moved_widgets' },
    });
    delete (partial as { schema?: unknown }).schema;
    expect(() =>
      ObjectRegistry.registerPackageManifest(
        packageOf({ [WIDGET]: partial, [SUB]: subScene(undefined) }),
      ),
    ).toThrow(UNDECLARED);
    expect(ObjectRegistry.getClass(WIDGET)?.schema?.tableName).toBe('widgets');
    expect(ObjectRegistry.getClass(WIDGET)?.config.tableName).toBe('widgets');
  });

  it('leaves no runtime override on the replacement key when a later entry is refused', () => {
    registerBase();
    ObjectRegistry.registerOverride(BASE, {
      api: false,
      mcp: false,
      cli: false,
    });
    const overrides = () => ({
      base: ObjectRegistry.getRuntimeOverride(BASE),
      sub: ObjectRegistry.getRuntimeOverride(SUB),
    });
    const before = overrides();
    expect(before.base).toBeDefined();
    const shot = entry(HISTRIO, 'Shot', { extends: 'Shot' });
    ObjectRegistry.registerFromManifest(
      `${VIDEO}:Shot`,
      entry(VIDEO, 'Shot'),
      VIDEO,
    );
    expect(() =>
      ObjectRegistry.registerPackageManifest(
        packageOf({
          [SUB]: subScene(true),
          [`${HISTRIO}:Shot`]: { ...shot, extendsQualified: `${VIDEO}:Shot` },
        }),
      ),
    ).toThrow(UNDECLARED);
    expect(overrides()).toEqual(before);
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(BASE);
  });

  it('still registers a valid package whole (control)', () => {
    registerBase();
    ObjectRegistry.registerPackageManifest(
      packageOf({
        [CLIP]: entry(HISTRIO, 'Clip'),
        [SUB]: subScene(true),
      }),
    );
    expect(ObjectRegistry.getClass(CLIP)?.qualifiedName).toBe(CLIP);
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(SUB);
    expect(getManifestCache().has(HISTRIO)).toBe(true);
  });
});
