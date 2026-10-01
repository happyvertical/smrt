import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestManager } from '../manager';

const files = vi.hoisted(() => new Map<string, string>());
const renameObservations = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => files.has(path)),
  readFileSync: vi.fn((path: string) => files.get(path)),
  writeFileSync: vi.fn((path: string, content: string) => {
    files.set(path, content);
  }),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ isFile: () => true, mode: 0o100644 })),
  chmodSync: vi.fn(),
  renameSync: vi.fn((from: string, to: string) => {
    renameObservations.push(files.get(to));
    const content = files.get(from);
    if (content === undefined)
      throw new Error(`Missing staged artifact: ${from}`);
    files.set(to, content);
    files.delete(from);
  }),
  unlinkSync: vi.fn((path: string) => {
    files.delete(path);
  }),
}));

// Mock ManifestGenerator to avoid deep dependency chain
const mockGenerateManifest = vi.fn();
vi.mock('../../scanner/manifest-generator.js', () => ({
  ManifestGenerator: class {
    generateManifest = mockGenerateManifest;
  },
}));

describe('ManifestManager', () => {
  const projectRoot = '/test/project';
  let manager: ManifestManager;

  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    renameObservations.length = 0;
    vi.mocked(fs.existsSync).mockImplementation((path) =>
      files.has(String(path)),
    );
    vi.mocked(fs.readFileSync).mockImplementation(
      (path) => files.get(String(path)) ?? '',
    );
    vi.mocked(fs.writeFileSync).mockImplementation((path, content) => {
      files.set(String(path), String(content));
    });
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      mode: 0o100644,
    } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      const target = String(to);
      renameObservations.push(files.get(target));
      const content = files.get(String(from));
      if (content === undefined) {
        throw new Error(`Missing staged artifact: ${String(from)}`);
      }
      files.set(target, content);
      files.delete(String(from));
    });
    vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      files.delete(String(path));
    });
    manager = new ManifestManager(projectRoot);
  });

  describe('paths', () => {
    it('should determine correct paths for dev and build modes', () => {
      expect(manager.getOutputPath('dev')).toBe(
        join(projectRoot, '.smrt/manifest.json'),
      );
      expect(manager.getOutputPath('build')).toBe(
        join(projectRoot, 'dist/manifest.json'),
      );
    });
  });

  describe('loadLocal', () => {
    it('should load from .smrt/manifest.json in dev mode', () => {
      const devPath = join(projectRoot, '.smrt/manifest.json');
      const mockManifest = { version: '1.0.0', objects: { test: {} } };

      vi.mocked(fs.existsSync).mockImplementation((path) => path === devPath);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockManifest));

      const result = manager.loadLocal();
      expect(result).toEqual(mockManifest);
      expect(fs.readFileSync).toHaveBeenCalledWith(devPath, 'utf-8');
    });

    it('should fall back to dist/manifest.json if .smrt/manifest.json does not exist', () => {
      const devPath = join(projectRoot, '.smrt/manifest.json');
      const distPath = join(projectRoot, 'dist/manifest.json');
      const mockManifest = { version: '1.0.0', objects: { test: {} } };

      vi.mocked(fs.existsSync).mockImplementation((path) => path === distPath);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockManifest));

      const result = manager.loadLocal();
      expect(result).toEqual(mockManifest);
      expect(fs.readFileSync).toHaveBeenCalledWith(distPath, 'utf-8');
    });

    it('should return null if no manifest exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(manager.loadLocal()).toBeNull();
    });
  });

  describe('write', () => {
    it('should write manifest to correct location and create directory if needed', () => {
      const devPath = join(projectRoot, '.smrt/manifest.json');
      const devDir = join(projectRoot, '.smrt');
      const mockManifest = { version: '1.0.0', objects: {} };

      vi.mocked(fs.existsSync).mockReturnValue(false);

      manager.write(mockManifest as any, 'dev');

      expect(fs.mkdirSync).toHaveBeenCalledWith(devDir, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(`${devPath}.smrt-`),
        JSON.stringify(mockManifest, null, 2),
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining(`${devPath}.smrt-`),
        devPath,
      );
    });

    it('replaces the manifest without making the previous file disappear', () => {
      const devPath = join(projectRoot, '.smrt/manifest.json');
      const previous = JSON.stringify({
        version: '1.0.0',
        objects: { old: {} },
      });
      const replacement = { version: '1.0.0', objects: { fresh: {} } };
      files.set(devPath, previous);

      manager.write(replacement as any, 'dev');

      expect(renameObservations).toEqual([previous]);
      expect(files.get(devPath)).toBe(JSON.stringify(replacement, null, 2));
      expect(files.has(devPath)).toBe(true);
    });
  });

  describe('generateFromScanResults', () => {
    it('should use ManifestGenerator and write the result', async () => {
      const mockManifest = { version: '1.0.0', objects: { generated: {} } };
      mockGenerateManifest.mockReturnValue(mockManifest);

      const result = await manager.generateFromScanResults([], { mode: 'dev' });

      expect(result).toEqual(mockManifest);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(
          `${join(projectRoot, '.smrt/manifest.json')}.smrt-`,
        ),
        JSON.stringify(mockManifest, null, 2),
        'utf-8',
      );
    });
  });
});
