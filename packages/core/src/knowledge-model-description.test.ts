import { describe, expect, it } from 'vitest';
import { buildDomainKnowledgeManifest } from './knowledge.js';
import type { SmartObjectManifest } from './scanner/types.js';

describe('model description in the knowledge artifact', () => {
  const manifest = {
    version: '1',
    timestamp: 1,
    packageName: '@example/orders',
    objects: {
      '@example/orders:Order': {
        className: 'Order',
        qualifiedName: '@example/orders:Order',
        packageName: '@example/orders',
        collection: 'orders',
        description: 'Customer purchase order',
        fields: {},
        methods: {},
        decoratorConfig: {},
      },
      '@example/orders:Bare': {
        className: 'Bare',
        qualifiedName: '@example/orders:Bare',
        packageName: '@example/orders',
        collection: 'bares',
        fields: {},
        methods: {},
        decoratorConfig: {},
      },
    },
  } as unknown as SmartObjectManifest;

  it('carries the manifest description and omits it when absent', () => {
    const artifact = buildDomainKnowledgeManifest({
      manifest,
      rootDir: '/tmp',
    });
    const order = artifact.objects.find((o) => o.name === 'Order');
    const bare = artifact.objects.find((o) => o.name === 'Bare');
    expect(order?.description).toBe('Customer purchase order');
    expect(bare && 'description' in bare).toBe(false);
  });
});
