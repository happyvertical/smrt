/**
 * A collection class never publishes more generated surface than its model.
 *
 * Covers the pure inheritance rule (`registry/collection-exposure.ts`), the
 * manifest generator pass that applies it at build time, the build guard,
 * the runtime registry layer that applies it to manifests built before the
 * rule, and the MCP tool list that results.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPGenerator } from '../../generators/mcp.js';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  exposedCrudVerbs,
  findCollectionWriteEscalations,
  inheritCollectionExposure,
} from '../collection-exposure.js';
import type { SmartObjectConfig } from '../types.js';

const PKG = '@happyvertical/smrt-collection-exposure-fixture';

function method(name: string): MethodDefinition {
  return {
    name,
    async: true,
    parameters: [{ name: 'id', type: 'string', optional: false }],
    returnType: 'Promise<void>',
    isStatic: false,
    isPublic: true,
  } as MethodDefinition;
}

function model(
  className: string,
  decoratorConfig: SmartObjectConfig,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: `${className.toLowerCase()}s`,
    filePath: `src/${className}.ts`,
    fields: { label: { type: 'text', required: false } },
    methods: { archive: method('archive') },
    decoratorConfig,
    extends: 'SmrtObject',
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

function collection(
  itemName: string,
  decoratorConfig: SmartObjectConfig = {},
  extendsName = 'SmrtCollection',
): SmartObjectDefinition {
  const className = `${itemName}Collection`;
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: `${className.toLowerCase()}s`,
    filePath: `src/${className}.ts`,
    fields: {},
    methods: {
      mintToken: method('mintToken'),
      archive: method('archive'),
    },
    decoratorConfig,
    extends: extendsName,
    extendsTypeArg: itemName,
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

function manifestOf(...objects: SmartObjectDefinition[]): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    packageName: PKG,
    objects: Object.fromEntries(
      objects.map((objectDef) => [objectDef.qualifiedName, objectDef]),
    ),
  };
}

/** The manifest shape smrt-core <= 0.56.1 produced: no exposure on the collection. */
function staleManifest(
  itemName: string,
  itemConfig: SmartObjectConfig,
): SmartObjectManifest {
  return manifestOf(model(itemName, itemConfig), collection(itemName));
}

function generated(manifest: SmartObjectManifest): SmartObjectManifest {
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: PKG,
  });
  return manifest;
}

const collectionConfig = (manifest: SmartObjectManifest, itemName: string) =>
  manifest.objects[`${PKG}:${itemName}Collection`].decoratorConfig;

describe('collection exposure inheritance rule', () => {
  it('reads CRUD verbs the way the MCP and CLI generators do', () => {
    expect(exposedCrudVerbs(undefined)).toEqual([
      'list',
      'get',
      'create',
      'update',
      'delete',
    ]);
    expect(exposedCrudVerbs(false)).toEqual([]);
    expect(exposedCrudVerbs({ include: ['get', 'archive'] })).toEqual(['get']);
    expect(exposedCrudVerbs({ exclude: ['delete'] })).toEqual([
      'list',
      'get',
      'create',
      'update',
    ]);
  });

  it('carries `false`, the CRUD verbs of include lists, and exclude lists', () => {
    expect(
      inheritCollectionExposure(
        {},
        {
          api: false,
          mcp: { include: ['list', 'get', 'archive'] },
          cli: { exclude: ['delete'] },
        },
      ),
    ).toEqual({
      api: false,
      mcp: { include: ['list', 'get'] },
      cli: { exclude: ['delete'] },
    });
  });

  it('carries a collection-hosted action the model publishes, with its route', () => {
    expect(
      inheritCollectionExposure(
        {},
        {
          api: {
            include: ['run', 'archive'],
            routes: {
              run: { method: 'POST', scope: 'collection', path: 'run' },
            },
          },
        },
        {
          collection: new Set(['run', 'archive']),
          item: new Set(['archive']),
        },
      ),
    ).toEqual({
      api: {
        include: ['run'],
        routes: { run: { method: 'POST', scope: 'collection', path: 'run' } },
      },
    });
  });

  it('leaves an open model and an own collection surface alone', () => {
    expect(inheritCollectionExposure({}, {})).toEqual({});
    expect(inheritCollectionExposure({}, { api: true, mcp: true })).toEqual({});
    expect(
      inheritCollectionExposure(
        { mcp: { include: ['list', 'mintToken'] } },
        { mcp: { include: [] } },
      ),
    ).toEqual({});
  });

  it('gives a sensitive model read-only MCP on its collection, even when the model is open', () => {
    expect(inheritCollectionExposure({}, { sensitive: true })).toEqual({
      mcp: { include: ['list', 'get'] },
    });
    expect(
      inheritCollectionExposure(
        {},
        { sensitive: true, mcp: { include: ['get', 'create'] } },
      ),
    ).toEqual({ mcp: { include: ['get'] } });
  });

  it('keeps the model acknowledgement of CLI commands without API routes', () => {
    expect(
      inheritCollectionExposure(
        {},
        { cli: { include: ['list', 'sync'], skipApiCheck: ['list', 'sync'] } },
      ),
    ).toEqual({ cli: { include: ['list'], skipApiCheck: ['list'] } });
  });

  it('finds CRUD writes a collection opens beyond its model', () => {
    expect(
      findCollectionWriteEscalations(
        { mcp: { include: ['list', 'create'] }, cli: true },
        { mcp: { include: ['list'] }, cli: { exclude: ['delete'] } },
      ),
    ).toEqual([
      { surface: 'mcp', verbs: ['create'] },
      { surface: 'cli', verbs: ['delete'] },
    ]);
    expect(
      findCollectionWriteEscalations(
        inheritCollectionExposure({}, { mcp: { include: [] }, cli: false }),
        { mcp: { include: [] }, cli: false },
      ),
    ).toEqual([]);
  });
});

describe('manifest generation: undecorated collections inherit their model surface', () => {
  it('inherits `false`', () => {
    const manifest = generated(
      staleManifest('Ledger', { api: false, mcp: false, cli: false }),
    );
    expect(collectionConfig(manifest, 'Ledger')).toMatchObject({
      api: false,
      mcp: false,
      cli: false,
    });
  });

  it('inherits include lists as CRUD verbs only', () => {
    const manifest = generated(
      staleManifest('Session', {
        api: { include: ['get', 'delete', 'archive'] },
        mcp: { include: [] },
        cli: { include: ['list', 'get'] },
      }),
    );
    expect(collectionConfig(manifest, 'Session')).toMatchObject({
      api: { include: ['get', 'delete'] },
      mcp: { include: [] },
      cli: { include: ['list', 'get'] },
    });
  });

  it('inherits exclude lists', () => {
    const manifest = generated(
      staleManifest('Folder', { mcp: { exclude: ['delete'] } }),
    );
    expect(collectionConfig(manifest, 'Folder').mcp).toEqual({
      exclude: ['delete'],
    });
  });

  it('also covers junction collections', () => {
    const manifest = generated(
      manifestOf(
        model('Grant', { mcp: { include: ['list'] } }),
        collection('Grant', {}, 'SmrtJunction'),
      ),
    );
    expect(collectionConfig(manifest, 'Grant').mcp).toEqual({
      include: ['list'],
    });
  });

  it("inherits a report model's read-only default", () => {
    const manifest = generated(
      manifestOf(
        model('Tally', { report: { source: 'Entry' } } as SmartObjectConfig),
        collection('Tally'),
      ),
    );
    expect(collectionConfig(manifest, 'Tally')).toMatchObject({
      api: { include: ['list', 'get'] },
      mcp: { include: ['list', 'get'] },
    });
  });

  it('keeps a collection own opt-in to its custom methods', () => {
    const manifest = generated(
      manifestOf(
        model('Entry', { api: { include: ['list'] }, mcp: { include: [] } }),
        collection('Entry', {
          api: { include: ['mintToken'] },
          mcp: { include: ['list'] },
        }),
      ),
    );
    expect(collectionConfig(manifest, 'Entry')).toMatchObject({
      api: { include: ['mintToken'] },
      mcp: { include: ['list'] },
    });
  });
});

describe('build guard: a collection may not open a write its model closes', () => {
  it('fails the build, naming the collection, transport and verbs', () => {
    const manifest = manifestOf(
      model('Secret', { sensitive: true, mcp: { include: ['list'] } }),
      collection('Secret', { mcp: { include: ['list', 'create', 'delete'] } }),
    );
    expect(() => generated(manifest)).toThrow(
      /SecretCollection opens mcp create\/delete, which .*:Secret does not/,
    );
  });

  it('passes an undecorated collection over any model', () => {
    expect(() =>
      generated(
        staleManifest('Secret', {
          sensitive: true,
          api: false,
          mcp: { include: [] },
          cli: { include: ['get'] },
        }),
      ),
    ).not.toThrow();
  });
});

describe('runtime: generated tools for a collection over a closed model', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  async function collectionTools(manifest: SmartObjectManifest) {
    ObjectRegistry.registerPackageManifest(manifest);
    const tools = await new MCPGenerator().generateTools();
    return tools
      .map((tool) => tool.name)
      .filter((name) => name.includes('collection_'))
      .sort();
  }

  it('closes CRUD writes and custom methods on a manifest built before the fix', async () => {
    // A stale manifest's collection entry carries no exposure at all, which
    // used to publish create/update/delete plus every public collection method.
    const manifest = staleManifest('Session', {
      sensitive: true,
      api: { include: ['get', 'delete'] },
      mcp: { include: [] },
      cli: false,
    });
    expect(collectionConfig(manifest, 'Session').mcp).toBeUndefined();
    expect(await collectionTools(manifest)).toEqual([]);
    expect(ObjectRegistry.getConfig(`${PKG}:SessionCollection`)).toMatchObject({
      mcp: { include: [] },
      cli: false,
    });
  });

  it('publishes only the reads a narrowed model publishes', async () => {
    expect(
      await collectionTools(
        staleManifest('Payment', { mcp: { include: ['list', 'get'] } }),
      ),
    ).toEqual(['paymentcollection_get', 'paymentcollection_list']);
  });

  it('gives a sensitive but otherwise open model read-only collection tools', async () => {
    expect(
      await collectionTools(staleManifest('ApiKey', { sensitive: true })),
    ).toEqual(['apikeycollection_get', 'apikeycollection_list']);
  });

  it('leaves the collection of an open model as it was', async () => {
    expect(await collectionTools(staleManifest('Note', {}))).toEqual([
      'notecollection_archive',
      'notecollection_create',
      'notecollection_delete',
      'notecollection_get',
      'notecollection_list',
      'notecollection_minttoken',
      'notecollection_update',
    ]);
  });

  it('keeps tools a collection lists itself', async () => {
    const manifest = manifestOf(
      model('Entry', { mcp: { include: ['list'] } }),
      collection('Entry', { mcp: { include: ['list', 'mintToken'] } }),
    );
    expect(await collectionTools(manifest)).toEqual([
      'entrycollection_list',
      'entrycollection_minttoken',
    ]);
  });
});
