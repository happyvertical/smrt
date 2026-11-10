/**
 * A model subclass never publishes more generated surface than its parent
 * model, unless it says so in `widenParentExposure`.
 *
 * Covers the pure rule (`registry/subclass-exposure.ts`), the manifest
 * generator pass that applies it at build time, the build guard, the runtime
 * registry layer that applies it to manifests built before the rule, and the
 * MCP tools that result for a subclass and its collection.
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
  findStaleWidenings,
  findSubclassExposureEscalations,
  inheritSubclassExposure,
  surfaceOpensOperation,
} from '../subclass-exposure.js';
import type { SmartObjectConfig } from '../types.js';

const PKG = '@happyvertical/smrt-subclass-exposure-fixture';

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
  extendsName = 'SmrtObject',
  methods: string[] = ['generateApiKey', 'linkIdentity'],
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: 'profiles',
    filePath: `src/${className}.ts`,
    fields: { label: { type: 'text', required: false } },
    methods: Object.fromEntries(methods.map((name) => [name, method(name)])),
    decoratorConfig,
    extends: extendsName,
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

function collection(
  itemName: string,
  decoratorConfig: SmartObjectConfig = {},
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
    methods: {},
    decoratorConfig,
    extends: 'SmrtCollection',
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

const PROFILE: SmartObjectConfig = {
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: { skipApiCheck: true },
};

/** The shape smrt-core <= 0.57.0 produced: the STI child restates nothing. */
function staleProfiles(): SmartObjectManifest {
  return manifestOf(
    model('Profile', PROFILE),
    model('Person', { tableStrategy: 'sti' }, 'Profile', ['greet']),
  );
}

function generated(manifest: SmartObjectManifest): SmartObjectManifest {
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: PKG,
  });
  return manifest;
}

const config = (manifest: SmartObjectManifest, className: string) =>
  manifest.objects[`${PKG}:${className}`].decoratorConfig;

describe('subclass exposure rule', () => {
  it('inherits every surface the subclass leaves unset, and sensitive', () => {
    expect(
      inheritSubclassExposure(
        { tableStrategy: 'sti', mcp: { include: ['list'] } },
        { ...PROFILE, sensitive: true },
      ),
    ).toEqual({
      api: PROFILE.api,
      cli: PROFILE.cli,
      sensitive: true,
    });
  });

  it('inherits nothing from an open parent', () => {
    expect(inheritSubclassExposure({}, { tableStrategy: 'sti' })).toEqual({});
  });

  it('reads include and exclude the way each transport does', () => {
    const crudOnly = { include: ['list', 'get'] };
    expect(surfaceOpensOperation('mcp', crudOnly, 'generateApiKey')).toBe(
      false,
    );
    expect(surfaceOpensOperation('api', crudOnly, 'generateApiKey')).toBe(
      false,
    );
    // The CLI keeps methods open under a CRUD-only include list.
    expect(surfaceOpensOperation('cli', crudOnly, 'generateApiKey')).toBe(true);
    expect(
      surfaceOpensOperation('cli', { include: ['get', 'sync'] }, 'other'),
    ).toBe(false);
    expect(
      surfaceOpensOperation(
        'mcp',
        { exclude: ['GenerateApiKey'] },
        'generateApiKey',
      ),
    ).toBe(false);
    expect(surfaceOpensOperation('mcp', false, 'list')).toBe(false);
    expect(surfaceOpensOperation('mcp', undefined, 'delete')).toBe(true);
  });

  it('finds verbs and parent methods a subclass opens', () => {
    expect(
      findSubclassExposureEscalations(
        { mcp: true, api: { include: ['list'] } },
        PROFILE,
        ['generateApiKey'],
      ),
    ).toEqual([{ surface: 'mcp', operations: ['delete', 'generateApiKey'] }]);
  });

  it('accepts operations named in widenParentExposure, and flags stale ones', () => {
    const child: SmartObjectConfig = {
      mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
      widenParentExposure: { mcp: ['delete'], api: ['delete'] },
    };
    expect(findSubclassExposureEscalations(child, PROFILE, [])).toEqual([]);
    expect(findStaleWidenings({ ...child, api: PROFILE.api }, PROFILE)).toEqual(
      [{ surface: 'api', operations: ['delete'] }],
    );
  });

  it('does not let a subclass drop sensitive', () => {
    expect(
      findSubclassExposureEscalations(
        { sensitive: false },
        { sensitive: true },
        [],
      ),
    ).toEqual([{ surface: 'sensitive', operations: [] }]);
  });
});

describe('manifest generator: a subclass inherits its parent model surface', () => {
  it("gives an STI child that restates nothing its base's surface", () => {
    const manifest = generated(staleProfiles());
    expect(config(manifest, 'Person')).toMatchObject({
      tableStrategy: 'sti',
      api: PROFILE.api,
      mcp: PROFILE.mcp,
      cli: PROFILE.cli,
    });
  });

  it('keeps the STI table and discriminator layout unchanged', () => {
    const manifest = generated(staleProfiles());
    expect(config(manifest, 'Person')).toMatchObject({
      tableName: 'profiles',
      tableStrategy: 'sti',
    });
    expect(manifest.objects[`${PKG}:Person`].collection).toBe(
      manifest.objects[`${PKG}:Profile`].collection,
    );
  });

  it('inherits through a grandparent', () => {
    const manifest = generated(
      manifestOf(
        model('Profile', PROFILE),
        model('Person', { tableStrategy: 'sti' }, 'Profile'),
        model('Employee', { tableStrategy: 'sti' }, 'Person'),
      ),
    );
    expect(config(manifest, 'Employee').mcp).toEqual(PROFILE.mcp);
  });

  it("lifts an abstract parent's synthesized write exclusions", () => {
    const manifest = generated(
      manifestOf(
        model('Contract', PROFILE),
        model(
          'SalesContract',
          { tableStrategy: 'sti', abstract: true },
          'Contract',
        ),
        model('Order', { tableStrategy: 'sti' }, 'SalesContract'),
      ),
    );
    // The abstract class itself is read-only; its concrete child gets the
    // surface the family authored.
    expect(config(manifest, 'SalesContract').mcp).toMatchObject({
      exclude: expect.arrayContaining(['create', 'update', 'delete']),
    });
    expect(config(manifest, 'Order').mcp).toEqual(PROFILE.mcp);
  });

  it("gives a subclass's undecorated collection the subclass's inherited surface", () => {
    const manifest = generated(
      manifestOf(
        ...Object.values(staleProfiles().objects),
        collection('Person'),
      ),
    );
    expect(config(manifest, 'PersonCollection').mcp).toEqual({
      include: ['list', 'get', 'create', 'update'],
    });
  });
});

describe('build guard: a subclass may narrow but not widen', () => {
  it('fails the build, naming the subclass, transport and operations', () => {
    const manifest = manifestOf(
      model('Profile', PROFILE),
      model(
        'Person',
        {
          tableStrategy: 'sti',
          mcp: { include: ['list', 'delete', 'generateApiKey'] },
        },
        'Profile',
      ),
    );
    expect(() => generated(manifest)).toThrow(
      /Person opens mcp delete, generateApiKey, which .*:Profile closes/,
    );
  });

  it('allows narrowing and opening methods only the subclass declares', () => {
    const manifest = manifestOf(
      model('Profile', PROFILE),
      model(
        'Person',
        { tableStrategy: 'sti', mcp: { include: ['list', 'greet'] } },
        'Profile',
        ['greet'],
      ),
    );
    expect(() => generated(manifest)).not.toThrow();
  });

  it('allows a widening the subclass declares', () => {
    const manifest = manifestOf(
      model('Profile', PROFILE),
      model(
        'Person',
        {
          tableStrategy: 'sti',
          mcp: { include: ['list', 'get', 'delete'] },
          widenParentExposure: { mcp: ['delete'] },
        },
        'Profile',
      ),
    );
    expect(() => generated(manifest)).not.toThrow();
  });

  it('rejects a widenParentExposure entry that widens nothing', () => {
    const manifest = manifestOf(
      model('Profile', PROFILE),
      model(
        'Person',
        { tableStrategy: 'sti', widenParentExposure: { mcp: ['list'] } },
        'Profile',
      ),
    );
    expect(() => generated(manifest)).toThrow(
      /lists mcp list in widenParentExposure/,
    );
  });

  it('rejects an explicit sensitive: false under a sensitive parent', () => {
    const manifest = manifestOf(
      model('Token', { sensitive: true, tableStrategy: 'cti' }),
      model('RefreshToken', { sensitive: false }, 'Token'),
    );
    expect(() => generated(manifest)).toThrow(/is not sensitive/);
  });
});

describe('runtime: generated tools for a subclass of a closed model', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  async function tools(manifest: SmartObjectManifest, prefix: string) {
    ObjectRegistry.registerPackageManifest(manifest);
    return (await new MCPGenerator().generateTools())
      .map((tool) => tool.name)
      .filter((name) => name.startsWith(prefix))
      .sort();
  }

  it("holds a manifest built before the fix to the parent's surface", async () => {
    // Before the fix `person_delete`, `person_generateapikey` and
    // `person_linkidentity` were listed although Profile closes them.
    expect(await tools(staleProfiles(), 'person_')).toEqual([
      'person_create',
      'person_get',
      'person_list',
      'person_update',
    ]);
    expect(ObjectRegistry.getConfig(`${PKG}:Person`)).toMatchObject({
      tableStrategy: 'sti',
      mcp: PROFILE.mcp,
      api: PROFILE.api,
    });
  });

  it("gives a subclass's collection its parent's restrictions", async () => {
    const manifest = manifestOf(
      ...Object.values(staleProfiles().objects),
      collection('Person'),
    );
    expect(await tools(manifest, 'personcollection_')).toEqual([
      'personcollection_create',
      'personcollection_get',
      'personcollection_list',
      'personcollection_update',
    ]);
  });

  it('inherits sensitive at runtime', () => {
    ObjectRegistry.registerPackageManifest(
      manifestOf(
        model('Token', { sensitive: true, tableStrategy: 'cti' }),
        model('RefreshToken', { tableStrategy: 'cti' }, 'Token'),
      ),
    );
    expect(ObjectRegistry.getConfig(`${PKG}:RefreshToken`).sensitive).toBe(
      true,
    );
  });

  it('leaves the subclass of an open model as it was', async () => {
    const manifest = manifestOf(
      model('Note', { tableStrategy: 'sti' }),
      model('Memo', { tableStrategy: 'sti' }, 'Note', ['pin']),
    );
    expect(await tools(manifest, 'memo_')).toEqual([
      'memo_create',
      'memo_delete',
      'memo_generateapikey',
      'memo_get',
      'memo_linkidentity',
      'memo_list',
      'memo_pin',
      'memo_update',
    ]);
  });
});
