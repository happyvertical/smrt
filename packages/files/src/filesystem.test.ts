import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getTempDirectory } from '@have/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFilesystem, LocalFilesystemProvider } from './index';
import { FileNotFoundError, FilesystemError } from './shared/types';

describe('Filesystem Interface', () => {
  let testDir: string;
  let fs: LocalFilesystemProvider;

  beforeEach(async () => {
    // Initialize providers for testing
    const { initializeProviders } = await import('./shared/factory.js');
    await initializeProviders();

    // Create a temporary test directory
    testDir = join(
      getTempDirectory(),
      'have-files-test',
      Math.random().toString(36),
    );
    await mkdir(testDir, { recursive: true });

    // Create filesystem instance
    fs = (await getFilesystem({
      type: 'local',
      basePath: testDir,
    })) as LocalFilesystemProvider;
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rmdir(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Factory Function', () => {
    it('should create local filesystem by default', async () => {
      const filesystem = await getFilesystem();
      expect(filesystem).toBeInstanceOf(LocalFilesystemProvider);
    });

    it('should create local filesystem explicitly', async () => {
      const filesystem = await getFilesystem({ type: 'local' });
      expect(filesystem).toBeInstanceOf(LocalFilesystemProvider);
    });

    it('should throw error for unknown provider', async () => {
      await expect(getFilesystem({ type: 'unknown' as any })).rejects.toThrow(
        'Unknown provider type: unknown',
      );
    });
  });

  describe('File Operations', () => {
    it('should check if file exists', async () => {
      expect(await fs.exists('nonexistent.txt')).toBe(false);

      await fs.write('test.txt', 'content');
      expect(await fs.exists('test.txt')).toBe(true);
    });

    it('should write and read files', async () => {
      const content = 'Hello, World!';
      await fs.write('test.txt', content);

      const readContent = await fs.read('test.txt');
      expect(readContent).toBe(content);
    });

    it('should write and read binary files', async () => {
      const buffer = Buffer.from([1, 2, 3, 4, 5]);
      await fs.write('binary.bin', buffer);

      const readBuffer = await fs.read('binary.bin', { raw: true });
      expect(Buffer.isBuffer(readBuffer)).toBe(true);
      expect(readBuffer).toEqual(buffer);
    });

    it('should handle different encodings', async () => {
      const content = 'Hello, 世界!';
      await fs.write('utf8.txt', content, { encoding: 'utf8' });

      const readContent = await fs.read('utf8.txt', { encoding: 'utf8' });
      expect(readContent).toBe(content);
    });

    it('should throw FileNotFoundError for missing files', async () => {
      await expect(fs.read('nonexistent.txt')).rejects.toThrow(
        FileNotFoundError,
      );
    });

    it('should delete files', async () => {
      await fs.write('delete-me.txt', 'content');
      expect(await fs.exists('delete-me.txt')).toBe(true);

      await fs.delete('delete-me.txt');
      expect(await fs.exists('delete-me.txt')).toBe(false);
    });

    it('should copy files', async () => {
      const content = 'Copy this content';
      await fs.write('source.txt', content);

      await fs.copy('source.txt', 'destination.txt');

      expect(await fs.exists('destination.txt')).toBe(true);
      expect(await fs.read('destination.txt')).toBe(content);
    });

    it('should move files', async () => {
      const content = 'Move this content';
      await fs.write('source.txt', content);

      await fs.move('source.txt', 'destination.txt');

      expect(await fs.exists('source.txt')).toBe(false);
      expect(await fs.exists('destination.txt')).toBe(true);
      expect(await fs.read('destination.txt')).toBe(content);
    });
  });

  describe('Directory Operations', () => {
    it('should create directories', async () => {
      await fs.createDirectory('subdir');
      expect(await fs.exists('subdir')).toBe(true);
    });

    it('should create nested directories', async () => {
      await fs.createDirectory('level1/level2/level3', { recursive: true });
      expect(await fs.exists('level1/level2/level3')).toBe(true);
    });

    it('should list directory contents', async () => {
      await fs.write('file1.txt', 'content1');
      await fs.write('file2.txt', 'content2');
      await fs.createDirectory('subdir');

      const contents = await fs.list('.');

      expect(contents).toHaveLength(3);
      expect(contents.map((f: any) => f.name).sort()).toEqual([
        'file1.txt',
        'file2.txt',
        'subdir',
      ]);
    });

    it('should list with filter', async () => {
      await fs.write('test.txt', 'content');
      await fs.write('test.log', 'log content');
      await fs.write('other.doc', 'doc content');

      const txtFiles = await fs.list('.', { filter: /\.txt$/ });
      expect(txtFiles).toHaveLength(1);
      expect(txtFiles[0].name).toBe('test.txt');
    });

    it('should list recursively', async () => {
      await fs.createDirectory('subdir');
      await fs.write('subdir/nested.txt', 'nested content');
      await fs.write('root.txt', 'root content');

      const contents = await fs.list('.', { recursive: true });

      expect(contents).toHaveLength(3); // root.txt, subdir, subdir/nested.txt
      expect(
        contents.some((f: any) => f.path.includes('subdir/nested.txt')),
      ).toBe(true);
    });

    it('should provide detailed file information', async () => {
      await fs.write('detailed.txt', 'content');

      const contents = await fs.list('.', { detailed: true });
      const file = contents.find((f: any) => f.name === 'detailed.txt');

      expect(file).toBeDefined();
      expect(file?.mimeType).toBe('text/plain');
      expect(file?.extension).toBe('txt');
      expect(file?.isDirectory).toBe(false);
      expect(file?.size).toBeGreaterThan(0);
    });
  });

  describe('File Statistics', () => {
    it('should get file stats', async () => {
      const content = 'Test content for stats';
      await fs.write('stats.txt', content);

      const stats = await fs.getStats('stats.txt');

      expect(stats.size).toBe(Buffer.byteLength(content));
      expect(stats.isFile).toBe(true);
      expect(stats.isDirectory).toBe(false);
      expect(stats.mtime).toBeInstanceOf(Date);
    });

    it('should get directory stats', async () => {
      await fs.createDirectory('stats-dir');

      const stats = await fs.getStats('stats-dir');

      expect(stats.isFile).toBe(false);
      expect(stats.isDirectory).toBe(true);
    });
  });

  describe('MIME Type Detection', () => {
    it('should detect text file MIME type', async () => {
      const mimeType = await fs.getMimeType('test.txt');
      expect(mimeType).toBe('text/plain');
    });

    it('should detect JSON file MIME type', async () => {
      const mimeType = await fs.getMimeType('data.json');
      expect(mimeType).toBe('application/json');
    });

    it('should default to octet-stream for unknown extensions', async () => {
      const mimeType = await fs.getMimeType('unknown.xyz');
      expect(mimeType).toBe('application/octet-stream');
    });
  });

  describe('Path Validation', () => {
    it('should reject path traversal attempts', async () => {
      await expect(fs.read('../../../etc/passwd')).rejects.toThrow(
        'Path contains invalid characters',
      );
    });

    it('should reject paths with tilde', async () => {
      await expect(fs.read('~/secret.txt')).rejects.toThrow(
        'Path contains invalid characters',
      );
    });

    it('should handle empty paths', async () => {
      await expect(fs.read('')).rejects.toThrow('Path cannot be empty');
    });
  });

  describe('Caching Operations', () => {
    it('should cache and retrieve data', async () => {
      const key = 'test-cache-key';
      const data = 'cached data';

      await fs.cache.set(key, data);
      const retrieved = await fs.cache.get(key);

      expect(retrieved).toBe(data);
    });

    it('should return undefined for missing cache entries', async () => {
      const retrieved = await fs.cache.get('nonexistent-key');
      expect(retrieved).toBeUndefined();
    });

    it('should respect cache expiry', async () => {
      const key = 'expiry-test';
      const data = 'data with expiry';

      await fs.cache.set(key, data);

      // Should retrieve within expiry
      const retrieved1 = await fs.cache.get(key, 10000); // 10 seconds
      expect(retrieved1).toBe(data);

      // Should not retrieve with very short expiry - wait a bit to ensure expiry
      await new Promise((resolve) => setTimeout(resolve, 10)); // Wait 10ms
      const retrieved2 = await fs.cache.get(key, 1); // 1 millisecond
      expect(retrieved2).toBeUndefined();
    });
  });

  describe('Provider Capabilities', () => {
    it('should return local provider capabilities', async () => {
      const capabilities = await fs.getCapabilities();

      expect(capabilities.streaming).toBe(true);
      expect(capabilities.atomicOperations).toBe(true);
      expect(capabilities.offlineCapable).toBe(true);
      expect(capabilities.versioning).toBe(false);
      expect(capabilities.sharing).toBe(false);
      expect(capabilities.realTimeSync).toBe(false);
      expect(capabilities.supportedOperations).toContain('read');
      expect(capabilities.supportedOperations).toContain('write');
    });
  });

  describe('Error Handling', () => {
    it('should provide meaningful error messages', async () => {
      try {
        await fs.read('nonexistent.txt');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect((error as FileNotFoundError).path).toBe('nonexistent.txt');
        expect((error as FileNotFoundError).provider).toBe('local');
      }
    });

    it('should handle permission errors gracefully', async () => {
      // This test might not work in all environments
      // but demonstrates the error handling pattern
      try {
        await fs.write('/root/protected.txt', 'content');
      } catch (error) {
        expect(error).toBeInstanceOf(FilesystemError);
      }
    });
  });

  describe('Options Handling', () => {
    it('should create parent directories when requested', async () => {
      await fs.write('deep/nested/file.txt', 'content', {
        createParents: true,
      });
      expect(await fs.exists('deep/nested/file.txt')).toBe(true);
    });

    it('should respect createMissing option in constructor', async () => {
      const fsNoCreate = new LocalFilesystemProvider({
        basePath: testDir,
        createMissing: false,
      });

      // Should fail without createParents option
      await expect(
        fsNoCreate.write('missing/dir/file.txt', 'content'),
      ).rejects.toThrow();
    });
  });
});

describe('Provider Registration', () => {
  it('should have local provider available', async () => {
    const { getAvailableProviders, isProviderAvailable, initializeProviders } =
      await import('./shared/factory.js');
    await initializeProviders();

    expect(getAvailableProviders()).toContain('local');
    expect(isProviderAvailable('local')).toBe(true);
  });

  it('should provide provider information', async () => {
    const { getProviderInfo, initializeProviders } = await import(
      './shared/factory.js'
    );
    await initializeProviders();

    const info = getProviderInfo('local');
    expect(info.available).toBe(true);
    expect(info.description).toContain('Local filesystem');
    expect(info.requiredOptions).toEqual([]);
  });

  it('should handle unavailable providers', async () => {
    const { getProviderInfo, initializeProviders } = await import(
      './shared/factory.js'
    );
    await initializeProviders();

    const s3Info = getProviderInfo('s3');
    expect(s3Info.description).toContain('S3');
    expect(s3Info.requiredOptions).toContain('region');
    expect(s3Info.requiredOptions).toContain('bucket');

    const webdavInfo = getProviderInfo('webdav');
    expect(webdavInfo.description).toContain('WebDAV');
    expect(webdavInfo.requiredOptions).toContain('baseUrl');
    expect(webdavInfo.requiredOptions).toContain('username');
    expect(webdavInfo.requiredOptions).toContain('password');

    const gdriveInfo = getProviderInfo('gdrive');
    expect(gdriveInfo.description).toContain('Google Drive');
    expect(gdriveInfo.requiredOptions).toContain('clientId');
    expect(gdriveInfo.requiredOptions).toContain('clientSecret');
    expect(gdriveInfo.requiredOptions).toContain('refreshToken');
  });
});
