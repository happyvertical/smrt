import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FileNotFoundError,
  type FilesystemInterface,
} from '@happyvertical/files';
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

  async function portableStore(basePath: string) {
    return new AssetStore(
      { type: 'local', basePath, locatorMode: 'relative' },
      {} as AssetCollection,
    ).initialize();
  }

  it('preserves a committed locator after the asset root changes', async () => {
    const first = await portableStore(await createDefaultBasePath());
    const second = await portableStore(await createDefaultBasePath());
    const asset = { id: 'retained', sourceUri: '' } as Asset;
    const opts = { mimeType: 'application/pdf', typeSlug: 'intake' };
    asset.sourceUri = await first.planFile(asset, opts);
    const data = Buffer.from('retained original');
    await first.preserveFile(asset, data, opts);
    expect(asset.sourceUri).toBe('asset-local:intake/retained.pdf');
    await expect(second.preserveFile(asset, data, opts)).resolves.toBe(
      asset.sourceUri,
    );
    await expect(second.preserveFile(asset, data, opts)).resolves.toBe(
      asset.sourceUri,
    );
    await expect(
      second.preserveFile(asset, Buffer.from('conflict'), opts),
    ).rejects.toThrow('integrity');
    await second.removeFile(asset);
    await second.removeFile(asset);
    await expect(first.read(asset)).resolves.toEqual(data);
  });

  it.each([
    '',
    '.',
    '../outside.txt',
    'folder/../outside.txt',
    '/absolute.txt',
    'C:/outside.txt',
    'folder\\outside.txt',
    'folder//file.txt',
    '%2e%2e/outside.txt',
    'folder/CON.txt',
    'folder/file.txt.',
  ])('rejects an unsafe portable locator %s on read and remove', async (key) => {
    const store = await portableStore(await createDefaultBasePath());
    const asset = { sourceUri: `asset-local:${key}` } as Asset;
    await expect(store.read(asset)).rejects.toThrow(
      'Invalid portable local asset',
    );
    await expect(store.removeFile(asset)).rejects.toThrow(
      'Invalid portable local asset',
    );
  });

  it('rejects invalid write inputs and pre-existing filesystem links', async () => {
    const base = await createDefaultBasePath();
    const other = await createDefaultBasePath();
    const outside = join(other, 'asset.txt');
    const sentinel = Buffer.from('outside bytes');
    await writeFile(outside, sentinel);
    await symlink(other, join(base, 'linked'), 'junction');
    await mkdir(join(base, 'file'));
    await symlink(outside, join(base, 'file', 'leaf.txt'), 'file');
    await link(outside, join(base, 'file', 'hard.txt'));
    const store = await portableStore(base);
    for (const [typeSlug, id] of [
      ['../escape', 'asset'],
      ['linked', 'asset'],
      ['file', 'leaf'],
      ['file', 'hard'],
    ]) {
      const asset = {
        id,
        sourceUri: `asset-local:${typeSlug}/${id}.txt`,
      } as Asset;
      const opts = { mimeType: 'text/plain', typeSlug };
      await expect(store.planFile(asset, opts)).rejects.toThrow(
        'Invalid portable local asset',
      );
      await expect(
        store.storeFile(asset, Buffer.from('new'), opts),
      ).rejects.toThrow('Invalid portable local asset');
      await expect(store.read(asset)).rejects.toThrow(
        'Invalid portable local asset',
      );
      await expect(store.removeFile(asset)).rejects.toThrow(
        'Invalid portable local asset',
      );
    }
    await expect(readFile(outside)).resolves.toEqual(sentinel);
  });

  it('rejects a configured root that is itself a link', async () => {
    const parent = await createDefaultBasePath();
    const target = await createDefaultBasePath();
    const root = join(parent, 'linked-root');
    await symlink(target, root, 'junction');
    const store = await portableStore(root);
    const asset = {
      id: 'existing',
      sourceUri: 'asset-local:file/existing.txt',
    } as Asset;
    await expect(
      store.planFile(asset, { mimeType: 'text/plain' }),
    ).rejects.toThrow('Invalid portable local asset path');
    await expect(store.read(asset)).rejects.toThrow(
      'Invalid portable local asset path',
    );
    await expect(store.removeFile(asset)).rejects.toThrow(
      'Invalid portable local asset path',
    );
  });

  it('reads only root-contained legacy locators in portable mode', async () => {
    const parent = await createDefaultBasePath();
    const base = join(parent, 'assets with spaces');
    const oldStore = await new AssetStore(
      base,
      {} as AssetCollection,
    ).initialize();
    const newStore = await portableStore(base);
    const asset = { id: 'existing', sourceUri: '' } as Asset;
    const bytes = Buffer.from('legacy bytes');
    asset.sourceUri = await oldStore.storeFile(asset, bytes, {
      mimeType: 'text/plain',
    });
    expect(asset.sourceUri).toBe(`file://${base}/file/existing.txt`);
    await expect(newStore.read(asset)).resolves.toEqual(bytes);
    const sibling = join(parent, 'assets with spaces-extra');
    await mkdir(sibling);
    await writeFile(join(sibling, 'outside.txt'), bytes);
    const foreign = { sourceUri: `file://${sibling}/outside.txt` } as Asset;
    await expect(newStore.read(foreign)).rejects.toThrow('configured root');
    await expect(newStore.removeFile(foreign)).rejects.toThrow(
      'configured root',
    );
    await expect(readFile(join(sibling, 'outside.txt'))).resolves.toEqual(
      bytes,
    );
    const canonical = pathToFileURL(join(base, 'file', 'existing.txt')).href;
    await expect(
      newStore.read({ sourceUri: canonical } as Asset),
    ).resolves.toEqual(bytes);
    const traversal = canonical.replace('/file/', '/file/%2e%2e/file/');
    await expect(
      newStore.read({ sourceUri: traversal } as Asset),
    ).rejects.toThrow();
    await newStore.removeFile({ sourceUri: canonical } as Asset);
    await expect(oldStore.read(asset)).rejects.toThrow();
  });

  it('keeps S3 routing and reads portable locators on legacy built-in local stores', async () => {
    const basePath = await createDefaultBasePath();
    const remote = createMemoryFilesystem();
    const providerOptions = {
      type: 's3' as const,
      region: 'test',
      bucket: 'remote',
    };
    const store = await new AssetStore(
      { type: 'local', basePath, locatorMode: 'relative' },
      {} as AssetCollection,
      { resolver: () => ({ filesystem: remote, providerOptions }) },
    ).initialize();
    const asset = { id: 'remote', sourceUri: '' } as Asset;
    const bytes = Buffer.from('remote bytes');
    asset.sourceUri = await store.storeFile(asset, bytes, {
      mimeType: 'text/plain',
    });
    expect(asset.sourceUri).toBe('s3://remote/file/remote.txt');
    await expect(store.read(asset)).resolves.toEqual(bytes);
    const portable = { sourceUri: 'asset-local:file/remote.txt' } as Asset;
    await expect(store.read(portable)).rejects.toThrow(
      'require the configured filesystem',
    );
    await expect(store.removeFile(portable)).rejects.toThrow(
      'require the configured filesystem',
    );
    const legacy = await new AssetStore(
      basePath,
      {} as AssetCollection,
    ).initialize();
    await legacy.storeFile(asset, bytes, { mimeType: 'text/plain' });
    await expect(legacy.read(portable)).resolves.toEqual(bytes);
    await legacy.removeFile(portable);
    await store.removeFile(asset);
    expect(remote.deleted).toEqual(['file/remote.txt']);
  });

  it('checks the final portable path and refuses resolver target changes', async () => {
    const basePath = await createDefaultBasePath();
    const remote = createMemoryFilesystem();
    const asset = { id: 'asset', sourceUri: '' } as Asset;
    const opts = { mimeType: 'text/plain' };
    const bytes = Buffer.from('nested asset');
    const resolver = vi.fn((request) =>
      request.operation === 'write'
        ? { path: `nested/${request.path}` }
        : undefined,
    );
    const store = await new AssetStore(
      { type: 'local', basePath, locatorMode: 'relative' },
      {} as AssetCollection,
      { resolver },
    ).initialize();
    asset.sourceUri = await store.storeFile(asset, bytes, opts);
    expect(asset.sourceUri).toBe('asset-local:nested/file/asset.txt');
    await expect(store.read(asset)).resolves.toEqual(bytes);
    resolver.mockReturnValueOnce({ path: '../outside.txt' });
    await expect(store.storeFile(asset, bytes, opts)).rejects.toThrow(
      'Invalid portable local asset',
    );
    resolver.mockReturnValueOnce({ path: 'other/asset.txt' });
    await expect(store.read(asset)).rejects.toThrow('does not match');
    const customStore = await new AssetStore(
      { type: 'local', basePath, locatorMode: 'relative' },
      {} as AssetCollection,
      {
        resolver: () => ({
          filesystem: remote,
          sourceUri: 'asset-local:file/asset.txt',
        }),
      },
    ).initialize();
    await expect(customStore.storeFile(asset, bytes, opts)).rejects.toThrow(
      'require the configured filesystem',
    );
    expect(remote.files.size).toBe(0);
  });

  it('plans and adopts retained bytes without rewriting them', async () => {
    const base = await createDefaultBasePath();
    const store = await new AssetStore(
      base,
      {} as AssetCollection,
    ).initialize();
    const asset = { id: 'retained', sourceUri: '' } as Asset;
    const opts = { mimeType: 'application/pdf', typeSlug: 'intake' };
    asset.sourceUri = await store.planFile(asset, opts);
    const data = Buffer.from('immutable original');
    expect(await store.preserveFile(asset, data, opts)).toBe(asset.sourceUri);
    expect(await store.preserveFile(asset, data, opts)).toBe(asset.sourceUri);
    await expect(
      store.preserveFile(asset, Buffer.from('changed'), opts),
    ).rejects.toThrow('integrity');
    expect(await store.read(asset)).toEqual(data);
  });

  it('refuses changed plans and never overwrites on a non-missing read failure', async () => {
    const base = await createDefaultBasePath();
    const fs = createMemoryFilesystem();
    const write = vi.spyOn(fs, 'write');
    fs.read = async () => {
      throw new Error('permission denied');
    };
    let prefix = 'stable';
    const store = await new AssetStore(base, {} as AssetCollection, {
      resolver: (request) => ({
        filesystem: fs,
        providerOptions: { type: 'local', basePath: base },
        path: `${prefix}/${request.asset.id}`,
      }),
    }).initialize();
    const asset = { id: 'retained', sourceUri: '' } as Asset;
    const opts = { mimeType: 'text/plain' };
    asset.sourceUri = await store.planFile(asset, opts);
    await expect(
      store.preserveFile(asset, Buffer.from('data'), opts),
    ).rejects.toThrow('permission denied');
    expect(write).not.toHaveBeenCalled();
    prefix = 'changed';
    await expect(
      store.preserveFile(asset, Buffer.from('data'), opts),
    ).rejects.toThrow('plan changed');
    expect(write).not.toHaveBeenCalled();
  });

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

  it('rejects filesystem-only write resolutions without a source URI', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const resolvedFilesystem = createMemoryFilesystem();
    const collection = {} as AssetCollection;
    const store = new AssetStore(defaultBasePath, collection, {
      resolver: async () => ({ filesystem: resolvedFilesystem }),
    });
    await store.initialize();

    await expect(
      store.storeFile(
        { id: 'asset-ambiguous' } as Asset,
        Buffer.from('ambiguous destination'),
        { mimeType: 'text/plain', typeSlug: 'document' },
      ),
    ).rejects.toThrow(/providerOptions or sourceUri/);
    expect(resolvedFilesystem.files.size).toBe(0);
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

  it('does not delete the asset record when delete resolution fails', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const collection = {} as AssetCollection;
    const deleteRecord = vi.fn(async () => {});
    const store = new AssetStore(defaultBasePath, collection, {
      resolver: async () => {
        throw new Error('node-local store is offline');
      },
    });
    await store.initialize();

    await expect(
      store.remove({
        sourceUri: `file://${defaultBasePath}/file/delete-me.bin`,
        delete: deleteRecord,
      } as unknown as Asset),
    ).rejects.toThrow('node-local store is offline');
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('still deletes the asset record when the resolved file is already gone', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const resolvedFilesystem = createMemoryFilesystem();
    const deleteFile = vi.fn(async (path: string) => {
      throw new FileNotFoundError(path, 'memory');
    });
    resolvedFilesystem.delete = deleteFile;
    const collection = {} as AssetCollection;
    const store = new AssetStore(defaultBasePath, collection, {
      resolver: async () => ({
        filesystem: resolvedFilesystem,
        path: 'replicas/missing.bin',
      }),
    });
    await store.initialize();
    const deleteRecord = vi.fn(async () => {});

    await store.remove({
      sourceUri: `file://${defaultBasePath}/file/missing.bin`,
      delete: deleteRecord,
    } as unknown as Asset);

    expect(deleteFile).toHaveBeenCalledWith('replicas/missing.bin');
    expect(deleteRecord).toHaveBeenCalledTimes(1);
  });

  it('preserves version metadata when no metadata override is provided', async () => {
    const defaultBasePath = await createDefaultBasePath();
    const save = vi.fn(async () => {});
    const collection = {
      createNewVersion: vi.fn(
        async (
          _primaryVersionId: string,
          _sourceUri: string,
          updates: Partial<Asset>,
        ) => ({
          id: 'asset-v2',
          sourceUri: '',
          mimeType: 'image/png',
          typeSlug: 'image',
          primaryVersionId: 'asset-v1',
          save,
          delete: vi.fn(async () => {}),
          ...updates,
        }),
      ),
    } as unknown as AssetCollection;
    const store = new AssetStore(defaultBasePath, collection);
    await store.initialize();

    await store.storeVersion(
      {
        id: 'asset-v1',
        mimeType: 'image/png',
        typeSlug: 'image',
        metadata: '{"keep":true}',
      } as Asset,
      Buffer.from('next version'),
    );

    expect(collection.createNewVersion).toHaveBeenCalledWith(
      'asset-v1',
      '',
      {},
    );
    expect(save).toHaveBeenCalledTimes(1);
  });
});
