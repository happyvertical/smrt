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

  it('builds a domain knowledge artifact from a SMRT manifest', () => {
    const manifest: SmartObjectManifest = {
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

    const artifact = buildDomainKnowledgeManifest({
      manifest,
      rootDir,
      manifestPath: join(rootDir, '.smrt', 'manifest.json'),
      config: {
        tags: ['commerce'],
        summary: 'Order package',
        risks: ['Ledger integration'],
      },
    });

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
    expect(artifact.objects.map((object) => object.name)).toEqual([
      'Order',
      'OrderLinks',
      'OrderTree',
    ]);
    expect(artifact.objects[0].tags).toEqual(['payments']);
    expect(artifact.surfaces.map((surface) => surface.name)).toEqual(
      expect.arrayContaining(['orders.get', 'order_get', 'order_approve']),
    );
    expect(artifact.relationshipsV2).toMatchObject({
      foreignKeyFields: 1,
      crossPackageRefFields: 1,
      junctionCollections: 1,
      hierarchicalObjects: 1,
      uuidColumns: 2,
    });
    expect(artifact.sourceHashes).toHaveProperty('packageJson');
    expect(artifact.sourceHashes).toHaveProperty('agents');
    expect(artifact.sourceHashes).toHaveProperty('manifest');
  });
});
