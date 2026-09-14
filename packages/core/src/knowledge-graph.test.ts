import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DomainKnowledgeManifest } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('resolves an STI extends target to the SAME package base, not an ambiguous global name (#2863 review)', () => {
    // Two packages each declare their own `Account` base class. `messages`
    // also declares an `EmailAccount` STI subclass extending its OWN
    // `Account`. Resolving `extends: 'Account'` globally is ambiguous (two
    // matches), so it must resolve within the declaring package instead of
    // silently pointing nowhere.
    const ledgers = manifest({
      packageName: '@example/ledgers',
      objects: [
        {
          name: 'Account',
          qualifiedName: '@example/ledgers/Account',
          collection: 'accounts',
          tableName: 'accounts',
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
    const messages = manifest({
      packageName: '@example/messages',
      objects: [
        {
          name: 'Account',
          qualifiedName: '@example/messages/Account',
          collection: 'accounts',
          tableName: 'accounts',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
        {
          name: 'EmailAccount',
          qualifiedName: '@example/messages/EmailAccount',
          collection: 'accounts',
          tableName: 'accounts',
          tableStrategy: 'sti',
          extends: 'Account',
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
        artifactPath: 'packages/ledgers/dist/smrt-knowledge.json',
        manifest: ledgers,
      },
      {
        artifactPath: 'packages/messages/dist/smrt-knowledge.json',
        manifest: messages,
      },
    ]);

    const sti = graph.edges.find(
      (e) => e.type === 'sti' && e.from.includes('EmailAccount'),
    );
    expect(sti).toEqual({
      type: 'sti',
      from: '@example/messages#@example/messages/EmailAccount',
      to: '@example/messages#@example/messages/Account',
    });
  });

  it('attributes objects by their own packageName in a merged consumer manifest (#2872)', () => {
    // smrtConsumer (packages/core/src/consumer-plugin/index.ts) writes one
    // local artifact whose top-level packageName is the consumer PROJECT,
    // but whose objects retain the packageName of whichever external
    // package they were actually scanned from.
    const aggregate = manifest({
      packageName: '@my-app/local',
      objects: [
        {
          name: 'Order',
          qualifiedName: '@happyvertical/smrt-orders/Order',
          packageName: '@happyvertical/smrt-orders',
          collection: 'orders',
          tableName: 'orders',
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        },
        {
          name: 'OrderLine',
          qualifiedName: '@happyvertical/smrt-orders/OrderLine',
          packageName: '@happyvertical/smrt-orders',
          collection: 'order_lines',
          tableName: 'order_lines',
          tableStrategy: 'sti',
          extends: 'Order',
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
      { artifactPath: '.smrt/smrt-knowledge.json', manifest: aggregate },
    ]);

    const orderNode = graph.objects.find((o) => o.name === 'Order');
    expect(orderNode?.packageName).toBe('@happyvertical/smrt-orders');
    expect(orderNode?.id).toBe(
      '@happyvertical/smrt-orders#@happyvertical/smrt-orders/Order',
    );

    const sti = graph.edges.find(
      (e) => e.type === 'sti' && e.from.includes('OrderLine'),
    );
    expect(sti?.to).toBe(
      '@happyvertical/smrt-orders#@happyvertical/smrt-orders/Order',
    );
  });

  it('preserves generatedAt across a rebuild when nothing merged changed (#2872)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const orders = manifest({ packageName: '@example/orders' });
      const inputs = [
        {
          artifactPath: 'packages/orders/dist/smrt-knowledge.json',
          manifest: orders,
        },
      ];

      const first = buildKnowledgeGraph(inputs);

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      const rebuilt = buildKnowledgeGraph(inputs, { previousGraph: first });
      expect(rebuilt.generatedAt).toBe(first.generatedAt);

      vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
      const changedOrders = manifest({
        packageName: '@example/orders',
        tags: ['changed'],
      });
      const changed = buildKnowledgeGraph(
        [
          {
            artifactPath: 'packages/orders/dist/smrt-knowledge.json',
            manifest: changedOrders,
          },
        ],
        { previousGraph: first },
      );
      expect(changed.generatedAt).not.toBe(first.generatedAt);
      expect(changed.generatedAt).toBe('2026-01-03T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
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

  it('flags a newly built package artifact the graph never merged (#2863 review)', () => {
    mkdirSync(join(rootDir, 'packages', 'orders', 'dist'), {
      recursive: true,
    });
    const original = manifest({ packageName: '@example/orders' });
    writeFileSync(
      join(rootDir, 'packages', 'orders', 'dist', 'smrt-knowledge.json'),
      stableStringify(original),
    );
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

    // Fresh before the new package exists.
    expect(
      checkKnowledgeGraphFreshness(rootDir, '.smrt/smrt-knowledge-graph.json'),
    ).toEqual([]);

    // A second package finishes its first build; every RECORDED hash is
    // still exactly correct, but the graph is now incomplete.
    mkdirSync(join(rootDir, 'packages', 'crm', 'dist'), { recursive: true });
    writeFileSync(
      join(rootDir, 'packages', 'crm', 'dist', 'smrt-knowledge.json'),
      stableStringify(manifest({ packageName: '@example/crm' })),
    );

    const stale = checkKnowledgeGraphFreshness(
      rootDir,
      '.smrt/smrt-knowledge-graph.json',
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].code).toBe('stale-knowledge-graph');
    expect(stale[0].message).toContain('packages/crm/dist/smrt-knowledge.json');
  });

  it('yields a stale-knowledge-graph issue rather than throwing on invalid source JSON (#2872)', () => {
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

    // Corrupt the recorded source artifact with invalid JSON.
    writeFileSync(artifactPath, '{ not valid json');

    expect(() =>
      checkKnowledgeGraphFreshness(rootDir, '.smrt/smrt-knowledge-graph.json'),
    ).not.toThrow();

    const issues = checkKnowledgeGraphFreshness(
      rootDir,
      '.smrt/smrt-knowledge-graph.json',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('stale-knowledge-graph');
    expect(issues[0].message).toContain('not valid JSON');
  });
});
