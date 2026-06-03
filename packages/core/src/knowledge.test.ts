import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDomainKnowledgeManifest } from './knowledge.js';
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
});

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
