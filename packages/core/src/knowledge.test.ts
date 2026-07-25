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
    ]);
    expect(artifact.objects[0].tags).toEqual(['payments']);
    expect(artifact.surfaces.map((surface) => surface.name)).toEqual(
      expect.arrayContaining(['orders.get', 'order_get', 'order_approve']),
    );
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
      foreignKeyFields: 1,
      crossPackageRefFields: 1,
      junctionCollections: 1,
      hierarchicalObjects: 1,
      uuidColumns: 3,
    });
  });

  it('records stable source hashes', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.sourceHashes).toHaveProperty('packageJson');
    expect(artifact.sourceHashes).toHaveProperty('agents');
    expect(artifact.sourceHashes).toHaveProperty('manifest');
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
        },
        methods: {
          approve: {
            name: 'approve',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {
          api: true,
          cli: { include: ['approve'] },
          mcp: { include: ['get', 'approve'] },
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
        fields: {},
        methods: {},
        decoratorConfig: {},
        extends: 'SmrtJunction',
      },
      '@example/orders:OrderTree': {
        className: 'OrderTree',
        qualifiedName: '@example/orders:OrderTree',
        collection: 'order_trees',
        fields: {},
        methods: {},
        decoratorConfig: {},
        extends: 'SmrtHierarchical',
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
