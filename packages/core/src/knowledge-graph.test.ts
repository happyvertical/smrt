import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DomainKnowledgeManifest } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildKnowledgeGraph,
  checkKnowledgeGraphFreshness,
  stableStringify,
} from './knowledge-graph.js';

function manifest(
  overrides: Partial<DomainKnowledgeManifest>,
): DomainKnowledgeManifest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourceHashes: {},
    exports: [],
    dependencies: {},
    smrtDependencies: [],
    sdkDependencies: [],
    tags: [],
    risks: [],
    objects: [],
    surfaces: [],
    prompts: [],
    relationshipsV2: {
      foreignKeyFields: 0,
      crossPackageRefFields: 0,
      junctionCollections: 0,
      hierarchicalObjects: 0,
      polymorphicAssociations: 0,
      uuidColumns: 0,
    },
    ...overrides,
  };
}

describe('buildKnowledgeGraph', () => {
  it('merges packages, objects, and derives typed cross-package edges', () => {
    const orders = manifest({
      packageName: '@example/orders',
      tags: ['commerce'],
      risks: ['sensitive-fields-excluded'],
      objects: [
        {
          name: 'Order',
          qualifiedName: '@example/orders/Order',
          collection: 'orders',
          tableName: 'orders',
          fields: [],
          relationships: [
            {
              name: 'customerId',
              type: 'crossPackageRef',
              related: '@example/crm/Customer',
            },
          ],
          methods: [],
          surfaces: [],
          relationshipFeatures: ['crossPackageRef'],
          tags: [],
          risks: [],
        },
        {
          name: 'OrderNote',
          qualifiedName: '@example/orders/OrderNote',
          collection: 'order_notes',
          tableName: 'order_notes',
          tableStrategy: 'sti',
          extends: '@example/orders/Order',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
        {
          name: 'OrderTag',
          qualifiedName: '@example/orders/OrderTag',
          collection: 'order_tags',
          tableName: 'order_tags',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: ['SmrtJunction'],
          tags: [],
          risks: [],
        },
        {
          name: 'DispatchLog',
          qualifiedName: '@example/orders/DispatchLog',
          collection: 'dispatch_log',
          tableName: '_smrt_dispatch_log',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
      ],
    });
    const crm = manifest({
      packageName: '@example/crm',
      objects: [
        {
          name: 'Customer',
          qualifiedName: '@example/crm/Customer',
          collection: 'customers',
          tableName: 'customers',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
      ],
    });

    const graph = buildKnowledgeGraph([
      {
        artifactPath: 'packages/orders/dist/smrt-knowledge.json',
        manifest: orders,
      },
      { artifactPath: 'packages/crm/dist/smrt-knowledge.json', manifest: crm },
    ]);

    expect(graph.schemaVersion).toBe(1);
    expect(graph.packages.map((p) => p.name)).toEqual([
      '@example/crm',
      '@example/orders',
    ]);
    expect(graph.objects).toHaveLength(5);

    const crossRef = graph.edges.find((e) => e.type === 'crossPackageRef');
    expect(crossRef).toEqual({
      type: 'crossPackageRef',
      from: '@example/orders#@example/orders/Order',
      to: '@example/crm#@example/crm/Customer',
      field: 'customerId',
    });

    const sti = graph.edges.find((e) => e.type === 'sti');
    expect(sti).toEqual({
      type: 'sti',
      from: '@example/orders#@example/orders/OrderNote',
      to: '@example/orders#@example/orders/Order',
    });

    expect(
      graph.edges.some(
        (e) =>
          e.type === 'junction' &&
          e.from === '@example/orders#@example/orders/OrderTag',
      ),
    ).toBe(true);

    const systemTable = graph.edges.find((e) => e.type === 'systemTable');
    expect(systemTable).toEqual({
      type: 'systemTable',
      from: '@example/orders#@example/orders/DispatchLog',
      to: '_smrt_dispatch_log',
    });
  });

  it('is deterministic regardless of input order', () => {
    const a = manifest({
      packageName: '@example/a',
      objects: [
        {
          name: 'A',
          qualifiedName: '@example/a/A',
          collection: 'a',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
      ],
    });
    const b = manifest({
      packageName: '@example/b',
      objects: [
        {
          name: 'B',
          qualifiedName: '@example/b/B',
          collection: 'b',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
      ],
    });

    const forward = buildKnowledgeGraph([
      { artifactPath: 'packages/a/dist/smrt-knowledge.json', manifest: a },
      { artifactPath: 'packages/b/dist/smrt-knowledge.json', manifest: b },
    ]);
    const backward = buildKnowledgeGraph([
      { artifactPath: 'packages/b/dist/smrt-knowledge.json', manifest: b },
      { artifactPath: 'packages/a/dist/smrt-knowledge.json', manifest: a },
    ]);

    const strip = (graph: ReturnType<typeof buildKnowledgeGraph>) => {
      const { generatedAt, ...rest } = graph;
      return rest;
    };
    expect(stableStringify(strip(forward))).toBe(
      stableStringify(strip(backward)),
    );
  });
});

describe('checkKnowledgeGraphFreshness', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-knowledge-graph-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns no issues when nothing requires the artifact and it is absent', () => {
    const issues = checkKnowledgeGraphFreshness(
      rootDir,
      '.smrt/smrt-knowledge-graph.json',
    );
    expect(issues).toEqual([]);
  });

  it('errors when the artifact is required but missing', () => {
    const issues = checkKnowledgeGraphFreshness(
      rootDir,
      '.smrt/smrt-knowledge-graph.json',
      { requireArtifact: true },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('missing-knowledge-graph');
  });

  it('detects a source artifact that changed since the graph was generated', () => {
    mkdirSync(join(rootDir, 'packages', 'orders', 'dist'), {
      recursive: true,
    });
    const artifactPath = join(
      rootDir,
      'packages',
      'orders',
      'dist',
      'smrt-knowledge.json',
    );
    const original = manifest({ packageName: '@example/orders' });
    writeFileSync(artifactPath, stableStringify(original));

    const graph = buildKnowledgeGraph([
      {
        artifactPath: 'packages/orders/dist/smrt-knowledge.json',
        manifest: original,
      },
    ]);
    mkdirSync(join(rootDir, '.smrt'), { recursive: true });
    writeFileSync(
      join(rootDir, '.smrt', 'smrt-knowledge-graph.json'),
      stableStringify(graph),
    );

    // Fresh: no issues.
    expect(
      checkKnowledgeGraphFreshness(rootDir, '.smrt/smrt-knowledge-graph.json'),
    ).toEqual([]);

    // Change the source artifact without regenerating the graph.
    writeFileSync(
      artifactPath,
      stableStringify(
        manifest({ packageName: '@example/orders', tags: ['x'] }),
      ),
    );

    const stale = checkKnowledgeGraphFreshness(
      rootDir,
      '.smrt/smrt-knowledge-graph.json',
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].code).toBe('stale-knowledge-graph');
  });
});
