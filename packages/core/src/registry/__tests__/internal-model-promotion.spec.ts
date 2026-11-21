/**
 * Internal-model stamps from a manifest entry (`internal`, `junction`,
 * `defaultedExposure`) reach the registration and survive stub promotion in
 * both loader orders: manifest then decorator, and decorator then manifest
 * (direct registration and lazy hydration), with a `getConfig()` between.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import type { SmartObjectDefinition } from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';
import { getRegistryGeneration } from '../generation';

const PKG = '@fixture/imo-promotion';
const TAG = `${PKG}:PromoTag`;
const LINKS = `${PKG}:PromoTagLinks`;

const discovered = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../manifest/manifest-loader.js')>();
  return {
    ...actual,
    discoverManifestEntry: (
      ...args: Parameters<typeof actual.discoverManifestEntry>
    ) => {
      const fixture = discovered.entries.get(args[1]);
      return fixture
        ? Promise.resolve(fixture)
        : actual.discoverManifestEntry(...args);
    },
  };
});

function tagEntry(
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    name: 'promotag',
    className: 'PromoTag',
    qualifiedName: TAG,
    packageName: PKG,
    collection: 'promotags',
    filePath: `/${PKG}/src/PromoTag.ts`,
    fields: { label: { type: 'text' } },
    methods: {},
    decoratorConfig: {},
    internal: 'junction',
    defaultedExposure: ['api', 'mcp', 'cli'],
    ...extra,
  } as SmartObjectDefinition;
}

function linksEntry(): SmartObjectDefinition {
  return {
    name: 'promotaglinks',
    className: 'PromoTagLinks',
    qualifiedName: LINKS,
    packageName: PKG,
    collection: 'promotags',
    filePath: `/${PKG}/src/PromoTagLinks.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    extends: 'SmrtJunction',
    extendsTypeArg: 'PromoTag',
    collectionOf: TAG,
    junction: true,
    junctionOf: TAG,
  } as SmartObjectDefinition;
}

const tagClass = () =>
  class PromoTag extends SmrtObject {
    label = '';
  };

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
  discovered.entries.clear();
});
afterEach(() => {
  discovered.entries.clear();
  restore();
});

describe('kind survives stub promotion: manifest→decorator and decorator→manifest, with a getConfig between', () => {
  it('stamped stub without constructor carries the kind, the junction flag and the defaulted surfaces', () => {
    ObjectRegistry.registerFromManifest(TAG, tagEntry(), PKG);
    ObjectRegistry.registerFromManifest(LINKS, linksEntry(), PKG);
    expect(ObjectRegistry.getClass(TAG)).toMatchObject({
      internalKind: 'junction',
      defaultedExposure: ['api', 'mcp', 'cli'],
    });
    expect(ObjectRegistry.getClass(LINKS)?.junctionCollection).toBe(true);
    expect(ObjectRegistry.getClass(LINKS)?.internalKind).toBeUndefined();
  });

  it('manifest stub first, then the decorator: the kind is kept', () => {
    ObjectRegistry.registerFromManifest(TAG, tagEntry(), PKG);
    ObjectRegistry.getConfig(TAG);
    const Tag = tagClass();
    smrt({ packageName: PKG })(Tag);
    const registered = ObjectRegistry.getClassByConstructor(Tag);
    expect(registered?.constructor).toBe(Tag);
    expect(registered?.internalKind).toBe('junction');
    expect(registered?.defaultedExposure).toEqual(['api', 'mcp', 'cli']);
  });

  it('decorator first, then the manifest entry: the kind is added and the generation bumps', () => {
    const Tag = tagClass();
    smrt({ packageName: PKG })(Tag);
    ObjectRegistry.getConfig(TAG);
    expect(ObjectRegistry.getClassByConstructor(Tag)?.internalKind).toBe(
      undefined,
    );
    const before = getRegistryGeneration();
    ObjectRegistry.registerFromManifest(TAG, tagEntry(), PKG);
    expect(getRegistryGeneration()).toBeGreaterThan(before);
    const registered = ObjectRegistry.getClassByConstructor(Tag);
    expect(registered?.constructor).toBe(Tag);
    expect(registered?.internalKind).toBe('junction');
  });

  it('decorator first, then lazy manifest hydration: the kind is added', async () => {
    const Tag = tagClass();
    smrt({ packageName: PKG })(Tag);
    ObjectRegistry.getConfig(TAG);
    discovered.entries.set(
      TAG,
      tagEntry({
        fields: { label: { type: 'text' }, color: { type: 'text' } },
      }) as unknown as Record<string, unknown>,
    );
    await ObjectRegistry.ensureManifestLoaded(TAG);
    expect(ObjectRegistry.getClassByConstructor(Tag)?.internalKind).toBe(
      'junction',
    );
  });

  it('a later entry without a stamp never clears the kind', () => {
    ObjectRegistry.registerFromManifest(TAG, tagEntry(), PKG);
    ObjectRegistry.registerFromManifest(
      TAG,
      tagEntry({ internal: undefined, defaultedExposure: undefined }),
      PKG,
    );
    expect(ObjectRegistry.getClass(TAG)?.internalKind).toBe('junction');
  });
});
