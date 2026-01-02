import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestManager } from '../manager';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
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
        devPath,
        JSON.stringify(mockManifest, null, 2),
      );
    });
  });

  describe('generateFromScanResults', () => {
    it('should use ManifestGenerator and write the result', async () => {
      const mockManifest = { version: '1.0.0', objects: { generated: {} } };
      mockGenerateManifest.mockReturnValue(mockManifest);

      const result = await manager.generateFromScanResults([], { mode: 'dev' });

      expect(result).toEqual(mockManifest);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        join(projectRoot, '.smrt/manifest.json'),
        JSON.stringify(mockManifest, null, 2),
      );
    });
  });
});
