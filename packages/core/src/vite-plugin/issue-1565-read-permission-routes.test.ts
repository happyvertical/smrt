/**
 * Generator-level coverage for issue #1565: generated SvelteKit routes pass
 * resolved caller permissions into `toPublicJSON()` and guard custom serializer
 * output with the same field-level read policy.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { generateSvelteKitRoutes } from './sveltekit-generator';

const projectRoot = '/test/project';

async function generateAndRead(api: unknown): Promise<{
  collectionRoute: string;
  itemRoute: string;
}> {
  await generateSvelteKitRoutes(
    projectRoot,
    {
      objects: {
        Product: {
          className: 'Product',
          collection: 'products',
          fields: {
            name: { type: 'text' },
            wholesalePrice: {
              type: 'decimal',
              readPermission: 'products.read.internal',
            },
          },
          methods: {},
          decoratorConfig: { api },
        },
      },
    } as unknown as SmartObjectManifest,
    {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
    },
  );

  const calls = vi.mocked(writeFileSync).mock.calls;
  const collectionRoute = calls.find((call) =>
    call[0].toString().endsWith('products/+server.ts'),
  )?.[1] as string;
  const itemRoute = calls.find((call) =>
    call[0].toString().includes('products/[id]/+server.ts'),
  )?.[1] as string;
  return { collectionRoute, itemRoute };
}

describe('Issue #1565: generated route read permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes locals.permissions into default public serialization', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead({
      include: ['list', 'get', 'create', 'update'],
    });

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toContain(
        'const READ_PERMISSION_FIELDS: Array<[string, string]> = [["wholesalePrice","products.read.internal"]];',
      );
      expect(content).toContain(
        'const publicJsonOptions = getPublicJsonOptions(locals);',
      );
      expect(content).toContain('l.permissions ?? l.permissionSet');
    }

    expect(collectionRoute).toContain(
      'items.map((item) => item.toPublicJSON(publicJsonOptions))',
    );
    expect(collectionRoute).toContain(
      'return json(item.toPublicJSON(publicJsonOptions), { status: 201 });',
    );
    expect(itemRoute).toContain('return item.toPublicJSON(publicJsonOptions);');
    expect(itemRoute).toContain(
      'return json(item.toPublicJSON(publicJsonOptions));',
    );
  });

  it('redacts read-permission fields from custom serializer output', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead({
      include: ['list', 'get', 'create', 'update'],
      serializers: {
        item: {
          exportName: 'serializeProduct',
          importPath: '$lib/serializers',
        },
      },
    });

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toContain('function applyReadPermissionRedaction(');
      expect(content).toContain(
        'applyReadPermissionRedaction(serializedItem, publicJsonOptions)',
      );
    }

    expect(collectionRoute).toContain(
      'applyReadPermissionRedaction(\n        await serializeItemResponse(item),\n        publicJsonOptions,\n      )',
    );
  });
});
