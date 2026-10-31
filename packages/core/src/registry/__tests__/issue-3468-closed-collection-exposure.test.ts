/**
 * Regression tests for #3468: a collection must keep its model's closed
 * generated surface through the scanner, the generated MCP tool list and
 * server, real tool invocation, and the model's own write guards.
 *
 * The scanner bakes an undecorated collection's surfaces from its model at
 * build time. Before this fix those baked values were indistinguishable from
 * the collection's own configuration, so a consumer that closed the model
 * afterwards (`ObjectRegistry.registerOverride`, or a consumer subclass whose
 * manifest replaces the package's) left `<model>collection_*` tools open
 * over rows the model no longer publishes. The surface tests that should
 * have caught it filtered tool names by the MODEL prefix only.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection.js';
import { MCPGenerator } from '../../generators/mcp.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import {
  capCollectionCrudToModel,
  closeWildcardExclusions,
  narrowInheritedCollectionSurface,
} from '../collection-exposure.js';
import type { SmartObjectConfig } from '../types.js';

const PKG = '@happyvertical/smrt-closed-collection-fixture';
const CRUD = ['list', 'get', 'create', 'update', 'delete'];

function method(name: string): MethodDefinition {
  return {
    name,
    async: true,
    parameters: [],
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
    methods: {},
    decoratorConfig,
    extends: 'SmrtObject',
    exportName: className,
  } as SmartObjectDefinition;
}

function collection(
  itemName: string,
  decoratorConfig: SmartObjectConfig = {},
  methods: string[] = [],
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
    methods: Object.fromEntries(methods.map((name) => [name, method(name)])),
    decoratorConfig,
    extends: 'SmrtCollection',
    extendsTypeArg: itemName,
    exportName: className,
  } as SmartObjectDefinition;
}

/** A package manifest through the real scanner passes. */
function generated(...objects: SmartObjectDefinition[]): SmartObjectManifest {
  const manifest: SmartObjectManifest = {
    version: '1',
    timestamp: 0,
    packageName: PKG,
    objects: Object.fromEntries(
      objects.map((objectDef) => [objectDef.qualifiedName, objectDef]),
    ),
  };
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: PKG,
  });
  return manifest;
}

const READS = { include: ['list', 'get'] };

/**
 * `Punch`: a read-only model with an undecorated collection (the
 * timesheets attendance shape). `Entry`: a read-only model whose collection
 * declares its own reads plus a custom query (the `ServiceTimeEntry` shape).
 */
function packageManifest(): SmartObjectManifest {
  return generated(
    model('Punch', { api: READS, mcp: READS, cli: READS }),
    collection('Punch'),
    model('Entry', { api: READS, mcp: READS, cli: READS }),
    collection('Entry', { mcp: { include: ['list', 'get', 'forWork'] } }, [
      'forWork',
    ]),
  );
}

const toolNames = async () =>
  (await new MCPGenerator().generateTools()).map((tool) => tool.name);

describe('#3468 surface combinators', () => {
  it('narrows a copied surface to the model now, never widening it', () => {
    expect(narrowInheritedCollectionSurface(READS, false)).toBe(false);
    expect(narrowInheritedCollectionSurface(READS, { include: [] })).toEqual({
      include: [],
    });
    expect(
      narrowInheritedCollectionSurface(READS, { include: ['list', 'get'] }),
    ).toEqual(READS);
    // A model the runtime leaves open does not reopen what the build closed.
    expect(narrowInheritedCollectionSurface(READS, undefined)).toBe(READS);
    expect(
      narrowInheritedCollectionSurface(
        { exclude: ['delete'] },
        { exclude: ['create'] },
      ),
    ).toEqual({ exclude: ['delete', 'create'] });
  });

  it('caps collection CRUD to the model and keeps custom methods', () => {
    expect(
      capCollectionCrudToModel(
        'mcp',
        { include: ['list', 'get', 'forWork'] },
        { mcp: false },
      ),
    ).toEqual({
      include: ['list', 'get', 'forWork'],
      exclude: ['list', 'get'],
    });
    expect(capCollectionCrudToModel('mcp', undefined, { mcp: READS })).toEqual({
      exclude: ['create', 'update', 'delete'],
    });
    expect(capCollectionCrudToModel('mcp', READS, { mcp: READS })).toBe(READS);
    // REST serves collection CRUD through the model's routes.
    expect(capCollectionCrudToModel('api', READS, { api: false })).toBe(READS);
    // A sensitive model publishes no MCP write through its collection.
    expect(
      capCollectionCrudToModel('mcp', undefined, { sensitive: true }),
    ).toEqual({ exclude: ['create', 'update', 'delete'] });
  });
});

describe("#3468 `exclude: ['*']` closes a surface", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('normalizes the wildcard to an empty include, keeping other options', () => {
    const config: SmartObjectConfig = {
      api: { exclude: ['*'] },
      mcp: { exclude: ['delete'] },
      cli: { include: ['list'] },
    };
    expect(closeWildcardExclusions(config)).toEqual({
      api: { include: [] },
      mcp: { exclude: ['delete'] },
      cli: { include: ['list'] },
    });
    const untouched = { mcp: { exclude: ['delete'] } };
    expect(closeWildcardExclusions(untouched)).toBe(untouched);
  });

  it('closes the model and its undecorated collection in the manifest and at runtime', async () => {
    const manifest = generated(
      model('Token', {
        sensitive: true,
        api: { exclude: ['*'] },
        mcp: { exclude: ['*'] },
        cli: { include: ['list'] },
      }),
      collection('Token', {}, ['verify']),
    );
    const token = manifest.objects[`${PKG}:Token`].decoratorConfig;
    const tokens = manifest.objects[`${PKG}:TokenCollection`].decoratorConfig;
    expect(token.api).toEqual({ include: [] });
    expect(token.mcp).toEqual({ include: [] });
    expect(tokens.api).toEqual({ include: [] });
    expect(tokens.mcp).toEqual({ include: [] });

    // A registration that never went through the scanner (a decorator, or a
    // manifest built before this fix) is closed by getConfig() too.
    const stale = generated(model('Raw', {}), collection('Raw'));
    stale.objects[`${PKG}:Raw`].decoratorConfig = {
      api: { exclude: ['*'] },
      mcp: { exclude: ['*'] },
    };
    ObjectRegistry.registerPackageManifest(manifest);
    ObjectRegistry.registerPackageManifest(stale);
    expect(ObjectRegistry.getConfig(`${PKG}:Raw`).mcp).toEqual({ include: [] });
    const tools = await toolNames();
    expect(
      tools.filter((name) => /^(token|raw)(collection)?_/.test(name)),
    ).toEqual([]);
  });
});

describe('#3468 closed exposure through scanner, MCP, and invocation', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('marks only the surfaces the scanner copied from the model', () => {
    const { objects } = packageManifest();
    expect(objects[`${PKG}:PunchCollection`].inheritedExposure).toEqual([
      'api',
      'mcp',
      'cli',
    ]);
    expect(objects[`${PKG}:EntryCollection`].inheritedExposure).toEqual([
      'api',
      'cli',
    ]);
    expect(objects[`${PKG}:Punch`].inheritedExposure).toBeUndefined();
  });

  it('closes collection tools when a consumer closes the model at runtime', async () => {
    ObjectRegistry.registerPackageManifest(packageManifest());
    const before = await toolNames();
    expect(before).toEqual(
      expect.arrayContaining([
        'punchcollection_list',
        'punchcollection_get',
        'entrycollection_list',
        'entrycollection_forwork',
      ]),
    );

    for (const name of ['Punch', 'Entry']) {
      ObjectRegistry.registerOverride(`${PKG}:${name}`, {
        api: false,
        mcp: false,
        cli: false,
      });
    }

    const after = await toolNames();
    expect(after.filter((tool) => /^punch(collection)?_/.test(tool))).toEqual(
      [],
    );
    // Generated CRUD over the closed model is gone; the collection's own
    // declared query keeps the existing opt-in policy.
    expect(after.filter((tool) => /^entry(collection)?_/.test(tool))).toEqual([
      'entrycollection_forwork',
    ]);
    const config = ObjectRegistry.getConfig(`${PKG}:PunchCollection`);
    expect(config.mcp).toBe(false);
    expect(config.cli).toBe(false);
    expect(config.api).toBe(false);

    // Real in-process invocation refuses the removed tools.
    const generator = new MCPGenerator();
    for (const tool of ['punchcollection_list', 'entrycollection_get']) {
      const response = await generator.handleToolCall({
        method: 'tools/call',
        params: { name: tool, arguments: {} },
      } as never);
      expect(response.isError, tool).toBe(true);
      expect(JSON.stringify(response.content), tool).toContain('Unknown tool');
    }

    // The standalone server `smrt generate mcp` writes has no case for them.
    const directory = await mkdtemp(join(tmpdir(), 'smrt-3468-'));
    let server: string;
    try {
      const outputPath = join(directory, 'index.ts');
      await new MCPGenerator().generateServer({ outputPath });
      server = await readFile(outputPath, 'utf8');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(server).toContain(`'entrycollection_forwork'`);
    for (const verb of CRUD) {
      expect(server).not.toContain(`'punchcollection_${verb}'`);
      expect(server).not.toContain(`'entrycollection_${verb}'`);
    }
  });

  it('never opens a copied surface wider than the build did', async () => {
    ObjectRegistry.registerPackageManifest(packageManifest());
    // A later registration that leaves the model open.
    const registered = ObjectRegistry.getClass(`${PKG}:Punch`);
    if (!registered) throw new Error('fixture model missing');
    registered.config = { ...registered.config, mcp: undefined };
    ObjectRegistry.invalidateInheritanceCache(`${PKG}:Punch`);

    const tools = (await toolNames()).filter((tool) =>
      tool.startsWith('punchcollection_'),
    );
    expect(tools.sort()).toEqual([
      'punchcollection_get',
      'punchcollection_list',
    ]);
  });
});

describe('#3468 collection writes keep the model guards', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('routes a collection delete through the model delete()', async () => {
    class Ledger3468 extends SmrtObject {
      label: string = '';
      override async delete(): Promise<void> {
        throw new Error('Ledger rows cannot be deleted.');
      }
    }
    class Ledger3468Collection extends SmrtCollection<Ledger3468> {
      static readonly _itemClass = Ledger3468;
    }
    ObjectRegistry.register(Ledger3468, {
      packageName: PKG,
      tableName: 'ledger_3468',
    });
    const db = await getTestDatabase({
      classes: [`${PKG}:Ledger3468`],
      includeSystemTables: false,
    });
    const rows = await (
      Ledger3468Collection as never as {
        create(options: object): Promise<SmrtCollection<Ledger3468>>;
      }
    ).create({ db });
    const row = await rows.create({ label: 'kept' });
    await expect(rows.delete(String(row.id))).rejects.toThrow(
      'Ledger rows cannot be deleted.',
    );
    expect(await rows.get(String(row.id))).not.toBeNull();
  });
});
