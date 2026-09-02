import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDomainKnowledgeManifest,
  resolveAgentModuleDocPaths,
} from './knowledge.js';
import type { SmartObjectManifest } from './scanner/types.js';

describe('buildDomainKnowledgeManifest', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-domain-knowledge-'));
    mkdirSync(join(rootDir, 'src', 'prompts'), { recursive: true });
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify(
        {
          name: '@example/orders',
          version: '1.0.0',
          exports: {
            '.': './dist/index.js',
            './smrt-knowledge.json': './dist/smrt-knowledge.json',
          },
          dependencies: {
            '@happyvertical/smrt-core': 'workspace:*',
            '@happyvertical/sql': 'catalog:',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(rootDir, 'AGENTS.md'),
      '# Orders\n\nReview payment and tenant boundaries.',
    );
    writeFileSync(
      join(rootDir, 'src', 'prompts', 'review.ts'),
      "export const review = definePrompt('orders.review', {});\n",
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('captures package metadata and authored context', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.packageName).toBe('@example/orders');
    expect(artifact.tags).toEqual(['commerce']);
    expect(artifact.summary).toBe('Order package');
    expect(artifact.risks).toEqual(['Ledger integration']);
    expect(artifact.sdkDependencies).toEqual(['@happyvertical/sql']);
    expect(artifact.exports).toContain('./smrt-knowledge.json');
    expect(artifact.agentDoc).toContain('Review payment');
    expect(artifact.prompts).toEqual([
      {
        filePath: 'src/prompts/review.ts',
        key: 'orders.review',
      },
    ]);
  });

  it('builds objects, surfaces, and object-level advisory metadata', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.objects.map((object) => object.name)).toEqual([
      'Order',
      'OrderLinks',
      'OrderTree',
      'OrderTreeCollection',
      'SpecialOrderTreeCollection',
    ]);
    expect(artifact.objects[0].tags).toEqual(['payments']);
    expect(artifact.surfaces.map((surface) => surface.name)).toEqual(
      expect.arrayContaining(['orders.get', 'order_get', 'order_approve']),
    );
  });

  it('reports full CRUD and eligible custom-method surfaces when api/cli/mcp config is omitted (#2619)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const orderLinksSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:OrderLinks',
    );
    const orderTreeSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:OrderTree',
    );

    // OrderLinks has no `api`/`cli`/`mcp` config at all — an omitted config
    // key is full CRUD, not a closed surface, mirroring the generators'
    // actual defaults.
    for (const kind of ['api', 'cli', 'mcp'] as const) {
      const names = orderLinksSurfaces
        .filter((surface) => surface.kind === kind)
        .map((surface) => surface.operation);
      expect(names.sort()).toEqual([
        'create',
        'delete',
        'get',
        'list',
        'update',
      ]);
    }

    // OrderTree additionally declares a public custom method (`archive`) and
    // a non-public one (`internalRebalance`); only the public method is
    // eligible, matching MCPGenerator/CLIGenerator/APIGenerator's own
    // isPublic gate.
    for (const kind of ['api', 'cli', 'mcp'] as const) {
      const names = orderTreeSurfaces
        .filter((surface) => surface.kind === kind)
        .map((surface) => surface.operation);
      expect(names.sort()).toEqual([
        'archive',
        'create',
        'delete',
        'get',
        'list',
        'update',
      ]);
    }
    expect(
      orderTreeSurfaces.some((surface) => surface.operation === 'archive'),
    ).toBe(true);
    expect(
      orderTreeSurfaces.some(
        (surface) => surface.operation === 'internalRebalance',
      ),
    ).toBe(false);
  });

  it('never reports CRUD for an undecorated SmrtCollection subclass, only its custom REST actions (#2619)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const collectionSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:OrderTreeCollection',
    );

    // A hand-written `class OrderTreeCollection extends
    // SmrtCollection<OrderTree>` never registers with ObjectRegistry, so
    // MCPGenerator/CLIGenerator generate nothing under its own name — only
    // its collection-scoped custom action reaches a REST route.
    expect(
      collectionSurfaces.filter((surface) => surface.kind === 'mcp'),
    ).toEqual([]);
    expect(
      collectionSurfaces.filter((surface) => surface.kind === 'cli'),
    ).toEqual([]);
    expect(
      collectionSurfaces
        .filter((surface) => surface.kind === 'api')
        .map((surface) => surface.operation),
    ).toEqual(['findAbandoned']);
  });

  it('walks the extends chain so a deeper collection subclass is still recognized (#2619)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const deepSurfaces = artifact.surfaces.filter(
      (surface) =>
        surface.objectName === '@example/orders:SpecialOrderTreeCollection',
    );

    // `SpecialOrderTreeCollection extends OrderTreeCollection` carries no
    // `extendsTypeArg` of its own — only its base does. Without walking the
    // extends chain through the manifest, this class would be mistaken for a
    // row model and gain a synthetic full-CRUD surface it does not have.
    expect(deepSurfaces.filter((surface) => surface.kind === 'mcp')).toEqual(
      [],
    );
    expect(deepSurfaces.filter((surface) => surface.kind === 'cli')).toEqual(
      [],
    );
    expect(
      deepSurfaces
        .filter((surface) => surface.kind === 'api')
        .map((surface) => surface.operation),
    ).toEqual(['findEscalated']);
  });

  it('projects structural facts without exposing sensitive fields', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const order = artifact.objects.find((object) => object.name === 'Order');

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.sensitiveFieldsExcluded).toBe(true);
    expect(order).toMatchObject({
      tenant: { scoped: true, mode: 'required', field: 'tenantId' },
      tableStrategy: 'sti',
      conflictColumns: ['tenant_id', 'profile_id'],
      methods: ['approve'],
      methodSignatures: [
        {
          name: 'approve',
          async: true,
          static: true,
          params: ['reason?: string'],
          returns: 'Promise<void>',
        },
      ],
    });
    expect(
      artifact.objects.find((object) => object.name === 'OrderLinks'),
    ).toMatchObject({
      relationshipFeatures: ['SmrtJunction', 'foreignKey'],
      conflictColumns: ['order_id', 'item_id'],
    });
    expect(order?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'attempts',
          default: 0,
          constraints: { min: 0, max: 3 },
          readonly: true,
        }),
        expect.objectContaining({ name: 'active', default: false }),
        expect.objectContaining({
          name: 'reference',
          constraints: { minLength: 2, maxLength: 24, pattern: '^[A-Z]+' },
        }),
        expect.objectContaining({ name: 'preview', transient: true }),
      ]),
    );
    expect(order?.fields.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
    expect(order?.relationships.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
  });

  it('redacts a sensitive tenant field identity while retaining tenant scope', () => {
    const manifest = fixtureManifest();
    manifest.objects['@example/orders:Order'].decoratorConfig.tenantScoped = {
      field: 'secretId',
      mode: 'optional',
    };
    const artifact = buildDomainKnowledgeManifest({ manifest, rootDir });
    const order = artifact.objects.find((object) => object.name === 'Order');

    expect(order?.tenant).toEqual({ scoped: true, mode: 'optional' });
  });

  it('preserves relationship details and relationships-v2 counts', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const order = artifact.objects.find((object) => object.name === 'Order');

    expect(order?.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tenantId',
          type: 'foreignKey',
          required: true,
          columnType: 'UUID',
        }),
        expect.objectContaining({
          name: 'profileId',
          type: 'crossPackageRef',
          columnType: 'UUID',
        }),
      ]),
    );
    expect(artifact.relationshipsV2).toMatchObject({
      foreignKeyFields: 3,
      crossPackageRefFields: 1,
      junctionCollections: 1,
      hierarchicalObjects: 1,
      uuidColumns: 3,
    });
  });

  it('records stable source hashes', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const rebuilt = buildFixtureArtifact(rootDir);
    const changedManifest = fixtureManifest();
    changedManifest.objects[
      '@example/orders:Order'
    ].decoratorConfig.conflictColumns = ['tenant_id', 'reference'];
    const changed = buildDomainKnowledgeManifest({
      manifest: changedManifest,
      rootDir,
    });

    expect(artifact.sourceHashes).toHaveProperty('packageJson');
    expect(artifact.sourceHashes).toHaveProperty('agents');
    expect(artifact.sourceHashes).toHaveProperty('manifest');
    expect(rebuilt.sourceHashes).toEqual(artifact.sourceHashes);
    expect(changed.sourceHashes.manifest).not.toBe(
      artifact.sourceHashes.manifest,
    );
  });

  it('omits moduleDocs when AGENTS.md links no sibling docs', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.moduleDocs).toBeUndefined();
    expect(
      Object.keys(artifact.sourceHashes).filter((key) =>
        key.startsWith('moduleDoc:'),
      ),
    ).toEqual([]);
  });

  it('loads and hashes the module docs AGENTS.md links (#2108)', () => {
    writeModuleDocs(rootDir);
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.moduleDocs).toEqual([
      expect.objectContaining({
        path: 'agents/payouts.md',
        module: 'payouts',
        content: expect.stringContaining('claimForPayout never double-owns'),
      }),
      expect.objectContaining({ path: 'agents/crm.md', module: 'crm' }),
    ]);
    expect(artifact.sourceHashes).toHaveProperty('moduleDoc:agents/payouts.md');
    expect(artifact.sourceHashes).toHaveProperty('moduleDoc:agents/crm.md');
  });

  it('still hashes module docs when doc bodies are excluded', () => {
    writeModuleDocs(rootDir);
    const artifact = buildDomainKnowledgeManifest({
      manifest: fixtureManifest(),
      rootDir,
      config: { includeDocs: false },
    });

    expect(artifact.agentDoc).toBeUndefined();
    expect(artifact.moduleDocs).toBeUndefined();
    expect(artifact.sourceHashes).toHaveProperty('moduleDoc:agents/payouts.md');
  });
});

describe('resolveAgentModuleDocPaths', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-module-docs-'));
    mkdirSync(join(rootDir, 'agents'), { recursive: true });
    writeFileSync(join(rootDir, 'agents', 'payouts.md'), '# payouts\n');
    writeFileSync(join(rootDir, 'AGENTS.md'), '# pkg\n');
    writeFileSync(join(rootDir, 'CLAUDE.md'), '@AGENTS.md');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('accepts a link to an existing file inside the package, once', () => {
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        '[a](agents/payouts.md) and again [b](agents/payouts.md)',
      ),
    ).toEqual(['agents/payouts.md']);
  });

  it('tolerates an anchor and a link title', () => {
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        '[a](agents/payouts.md#claims) [b](agents/payouts.md "Payouts")',
      ),
    ).toEqual(['agents/payouts.md']);
  });

  it('ignores non-links, missing files, and remote targets', () => {
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        'see `agents/payouts.md`, [gone](agents/missing.md), [x](https://e.dev/a.md)',
      ),
    ).toEqual([]);
  });

  it('ignores links that escape the package or point back at the chain', () => {
    // A cross-package doc belongs to that package's own instruction chain, and
    // re-including AGENTS.md/CLAUDE.md would double-count the chain itself.
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        '[o](../other/AGENTS.md) [s](AGENTS.md) [c](CLAUDE.md)',
      ),
    ).toEqual([]);
  });

  it('returns nothing without an agent doc', () => {
    expect(resolveAgentModuleDocPaths(rootDir, undefined)).toEqual([]);
  });
});

function writeModuleDocs(rootDir: string): void {
  mkdirSync(join(rootDir, 'agents'), { recursive: true });
  writeFileSync(
    join(rootDir, 'agents', 'payouts.md'),
    '# payouts\n\n`claimForPayout never double-owns` a row.\n',
  );
  writeFileSync(
    join(rootDir, 'agents', 'crm.md'),
    '# crm\n\nLeads and pipelines.\n',
  );
  writeFileSync(
    join(rootDir, 'AGENTS.md'),
    [
      '# Orders',
      '',
      'Review payment and tenant boundaries.',
      '',
      '| Module | Module doc |',
      '|---|---|',
      '| payouts | [agents/payouts.md](agents/payouts.md) |',
      '| crm | [agents/crm.md](agents/crm.md) |',
    ].join('\n'),
  );
}

function buildFixtureArtifact(rootDir: string) {
  return buildDomainKnowledgeManifest({
    manifest: fixtureManifest(),
    rootDir,
    manifestPath: join(rootDir, '.smrt', 'manifest.json'),
    config: {
      tags: ['commerce'],
      summary: 'Order package',
      risks: ['Ledger integration'],
    },
  });
}

function fixtureManifest(): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 1,
    packageName: '@example/orders',
    packageVersion: '1.0.0',
    objects: {
      '@example/orders:Order': {
        className: 'Order',
        qualifiedName: '@example/orders:Order',
        collection: 'orders',
        fields: {
          tenantId: {
            type: 'foreignKey',
            required: true,
            related: 'Tenant',
          },
          profileId: {
            type: 'crossPackageRef',
            related: '@happyvertical/smrt-profiles:Profile',
          },
          attempts: {
            type: 'integer',
            default: 0,
            min: 0,
            max: 3,
            readonly: true,
          },
          active: { type: 'boolean', default: false },
          reference: {
            type: 'text',
            _meta: {
              minLength: 2,
              maxLength: 24,
              pattern: { source: '^[A-Z]+' },
            },
          },
          preview: { type: 'text', _meta: { transient: true } },
          secretId: {
            type: 'foreignKey',
            related: 'Secret',
            sensitive: true,
          },
          legacySecretId: {
            type: 'foreignKey',
            related: 'LegacySecret',
            _meta: { sensitive: true },
          },
          apiTokenID: { type: 'text', _meta: { sensitive: true } },
        },
        methods: {
          approve: {
            name: 'approve',
            async: true,
            parameters: [
              {
                name: 'reason',
                type: 'string',
                optional: true,
              },
            ],
            returnType: 'Promise<void>',
            isStatic: true,
            isPublic: true,
          },
        },
        decoratorConfig: {
          api: true,
          cli: { include: ['approve'] },
          mcp: { include: ['get', 'approve'] },
          tenantScoped: true,
          tableStrategy: 'sti',
          conflictColumns: [
            'tenant_id',
            'profile_id',
            'secret_id',
            'legacy_secret_id',
            'api_token_i_d',
          ],
          knowledge: {
            tags: ['payments'],
            summary: 'Order aggregate',
            risks: ['Payment state transitions are sensitive'],
          },
        },
        extends: 'SmrtObject',
        schema: {
          tableName: 'orders',
          columns: {
            id: { type: 'UUID' },
            tenant_id: { type: 'UUID' },
            profile_id: { type: 'UUID' },
          },
        },
      },
      '@example/orders:OrderLinks': {
        className: 'OrderLinks',
        qualifiedName: '@example/orders:OrderLinks',
        collection: 'order_links',
        fields: {
          orderId: { type: 'foreignKey', related: 'Order', required: true },
          itemId: { type: 'foreignKey', related: 'Item', required: true },
        },
        methods: {},
        decoratorConfig: { conflictColumns: ['order_id', 'item_id'] },
        extends: 'SmrtJunction',
      },
      '@example/orders:OrderTree': {
        className: 'OrderTree',
        qualifiedName: '@example/orders:OrderTree',
        collection: 'order_trees',
        fields: {},
        methods: {
          archive: {
            name: 'archive',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
          internalRebalance: {
            name: 'internalRebalance',
            async: false,
            parameters: [],
            returnType: 'void',
            isStatic: false,
            isPublic: false,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtHierarchical',
      },
      '@example/orders:OrderTreeCollection': {
        className: 'OrderTreeCollection',
        qualifiedName: '@example/orders:OrderTreeCollection',
        collection: 'order_trees',
        fields: {},
        methods: {
          findAbandoned: {
            name: 'findAbandoned',
            async: true,
            parameters: [],
            returnType: 'Promise<OrderTree[]>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtCollection',
        extendsTypeArg: 'OrderTree',
      },
      '@example/orders:SpecialOrderTreeCollection': {
        className: 'SpecialOrderTreeCollection',
        qualifiedName: '@example/orders:SpecialOrderTreeCollection',
        collection: 'order_trees',
        fields: {},
        methods: {
          findEscalated: {
            name: 'findEscalated',
            async: true,
            parameters: [],
            returnType: 'Promise<OrderTree[]>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        // A deeper collection subclass carries no `extendsTypeArg` of its
        // own — only its `OrderTreeCollection` base does. Recognizing it as
        // a collection class requires walking the extends chain (#2619).
        extends: 'OrderTreeCollection',
        extendsQualified: '@example/orders:OrderTreeCollection',
      },
      '@example/orders:HiddenOrder': {
        className: 'HiddenOrder',
        qualifiedName: '@example/orders:HiddenOrder',
        collection: 'hidden_orders',
        fields: {},
        methods: {},
        decoratorConfig: { knowledge: false },
        extends: 'SmrtObject',
      },
    },
  };
}
