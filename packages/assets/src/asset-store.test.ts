import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilesystemInterface } from '@happyvertical/files';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from './asset.js';
import { AssetStore } from './asset-store.js';
import type { AssetCollection } from './assets.js';

interface MemoryFilesystem extends FilesystemInterface {
  files: Map<string, Buffer>;
  deleted: string[];
}

function createMemoryFilesystem(
  initialFiles: Record<string, Buffer | string> = {},
): MemoryFilesystem {
  const files = new Map<string, Buffer>();
  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }

  return {
    files,
    deleted: [],
    async read(path: string) {
      const data = files.get(path);
      if (!data) throw new Error(`Missing test file: ${path}`);
      return data;
    },
    async write(path: string, content: string | Buffer) {
      files.set(
        path,
        Buffer.isBuffer(content) ? content : Buffer.from(content),
      );
    },
    async delete(path: string) {
      files.delete(path);
      this.deleted.push(path);
    },
  } as unknown as MemoryFilesystem;
}

describe('AssetStore storage resolver', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createDefaultBasePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'smrt-assets-'));
    tempDirs.push(dir);
    return dir;
  }

  it('lets writes target a resolved filesystem instead of the default store', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const resolvedFilesystem = createMemoryFilesystem();
    const collection = {} as AssetCollection;
    const resolver = vi.fn(async (request) => ({
      filesystem: resolvedFilesystem,
      providerOptions: { type: 'local' as const, basePath: '/tenant-store' },
      path: `tenant-a/${request.path}`,
    }));
    const store = new AssetStore(defaultBasePath, collection, { resolver });
    await store.initialize();

    const sourceUri = await store.storeFile(
      { id: 'asset-1' } as Asset,
      Buffer.from('hello tenant storage'),
      { mimeType: 'image/png', typeSlug: 'image' },
    );

    expect(sourceUri).toBe('file:///tenant-store/tenant-a/image/asset-1.png');
    expect(resolvedFilesystem.files.get('tenant-a/image/asset-1.png')).toEqual(
      Buffer.from('hello tenant storage'),
    );
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'write',
        path: 'image/asset-1.png',
        sourceUri: `file://${defaultBasePath}/image/asset-1.png`,
        mimeType: 'image/png',
        typeSlug: 'image',
      }),
    );
  });

  it('lets reads choose a resolved location for the logical asset', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const resolvedFilesystem = createMemoryFilesystem({
      'replicas/video.mp4': 'from replica',
    });
    const collection = {} as AssetCollection;
    const resolver = vi.fn(async () => ({
      filesystem: resolvedFilesystem,
      path: 'replicas/video.mp4',
      sourceUri: 's3://tenant-assets/replicas/video.mp4',
    }));
    const store = new AssetStore(defaultBasePath, collection, { resolver });
    await store.initialize();

    const data = await store.read({
      sourceUri: `file://${defaultBasePath}/video/original.mp4`,
    } as Asset);

    expect(data.toString()).toBe('from replica');
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'read',
        path: 'video/original.mp4',
        sourceUri: `file://${defaultBasePath}/video/original.mp4`,
      }),
    );
  });

  it('lets deletes target a resolved location before deleting the asset record', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const resolvedFilesystem = createMemoryFilesystem({
      'replicas/delete-me.bin': 'data',
    });
    const collection = {} as AssetCollection;
    const store = new AssetStore(defaultBasePath, collection, {
      resolver: async () => ({
        filesystem: resolvedFilesystem,
        path: 'replicas/delete-me.bin',
      }),
    });
    await store.initialize();
    const deleteRecord = vi.fn(async () => {});

    await store.remove({
      sourceUri: `file://${defaultBasePath}/file/delete-me.bin`,
      delete: deleteRecord,
    } as unknown as Asset);

    expect(resolvedFilesystem.deleted).toEqual(['replicas/delete-me.bin']);
    expect(deleteRecord).toHaveBeenCalledTimes(1);
  });
});
