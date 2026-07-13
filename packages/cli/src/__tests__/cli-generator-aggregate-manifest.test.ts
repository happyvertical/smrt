import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';
import { loadManifest } from '../discovery/manifest-discovery.js';

const { loadLocalTestManifestSyncMock } = vi.hoisted(() => ({
  loadLocalTestManifestSyncMock: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core/manifest', () => ({
  loadLocalTestManifestSync: loadLocalTestManifestSyncMock,
}));

describe('CLIGenerator aggregate manifest preload', () => {
  let tempDir: string;

  const qualifiedName =
    '@happyvertical/smrt-content:ContentFeedSource' as const;
  const externalDefinition = {
    className: 'ContentFeedSource',
    qualifiedName,
    packageName: '@happyvertical/smrt-content',
    filePath: '/build/smrt-content/src/content-feed-source.ts',
    fields: {
      tenantId: {
        type: 'text' as const,
        required: false,
        _meta: {
          sqlType: 'UUID',
          __tenancy: {
            isTenantIdField: true,
            mode: 'optional' as const,
          },
        },
      },
      feedUrl: {
        type: 'text' as const,
        required: true,
      },
    },
    decoratorConfig: {
      tableName: 'content_feed_sources',
      tenantScoped: { mode: 'optional' as const },
    },
    schema: {
      tableName: 'content_feed_sources',
      ddl: '',
      columns: {
        tenant_id: {
          type: 'UUID' as const,
          referenceKind: 'tenantId' as const,
        },
        feed_url: { type: 'TEXT' as const, notNull: true },
      },
      indexes: [],
      version: 'fixture',
    },
  };

  beforeEach(async () => {
    ObjectRegistry.clear();
    tempDir = await mkdtemp(join(tmpdir(), 'smrt-cli-aggregate-test-'));
    loadLocalTestManifestSyncMock.mockReturnValue({
      packageName: '@test/app',
      objects: {
        '@test/app:LocalObject': {
          className: 'LocalObject',
          qualifiedName: '@test/app:LocalObject',
          packageName: '@test/app',
        },
        [qualifiedName]: externalDefinition,
      },
    });
  });

  afterEach(async () => {
    ObjectRegistry.clear();
    loadLocalTestManifestSyncMock.mockReset();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('preserves external qualified identity and metadata after duplicate discovery', async () => {
    const cli = new CLIGenerator({ prompt: false, colors: false });
    const internalCli = cli as unknown as {
      ensureManifestLoaded(): Promise<void>;
      tryLoadUserClasses(): Promise<void>;
    };
    vi.spyOn(internalCli, 'tryLoadUserClasses').mockResolvedValue(undefined);

    await internalCli.ensureManifestLoaded();

    const preloaded = ObjectRegistry.getClassByQualifiedName(qualifiedName);
    expect(preloaded).toBeDefined();
    expect(preloaded?.packageName).toBe('@happyvertical/smrt-content');
    expect(preloaded?.qualifiedName).toBe(qualifiedName);
    expect(preloaded?.fields.get('tenantId')?._meta).toMatchObject({
      sqlType: 'UUID',
      __tenancy: {
        isTenantIdField: true,
        mode: 'optional',
      },
    });

    const packageDir = join(
      tempDir,
      'node_modules',
      '@happyvertical',
      'content',
    );
    await mkdir(packageDir, { recursive: true });
    const packageManifestPath = join(packageDir, 'manifest.json');
    await writeFile(
      packageManifestPath,
      JSON.stringify({
        packageName: '@happyvertical/smrt-content',
        objects: { [qualifiedName]: externalDefinition },
      }),
    );

    await loadManifest(packageManifestPath);

    const rediscovered = ObjectRegistry.getClassByQualifiedName(qualifiedName);
    expect(rediscovered).toBe(preloaded);
    expect(rediscovered?.fields.get('tenantId')?._meta).toEqual(
      preloaded?.fields.get('tenantId')?._meta,
    );
    expect(
      ObjectRegistry.getClassByQualifiedName('@test/app:ContentFeedSource'),
    ).toBeUndefined();
  });
});
