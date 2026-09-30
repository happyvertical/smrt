import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSmrtManifests } from '../index.js';

// #2895: the per-package "Loaded N classes from <pkg>" lines must be
// verbose-only (no more `verbose || registered > 0`), and the per-process
// "Loaded manifests from N/M packages" summary must log at most once per
// process regardless of how many times setup runs in that worker -- unless
// verbose is on, in which case every call still logs its own summary.

const mockedModules = vi.hoisted(() => ({
  hasClass: vi.fn<(name: string) => boolean>(),
  registerFromManifest:
    vi.fn<(name: string, objectDef: unknown, packageName?: string) => void>(),
  loadLocal:
    vi.fn<
      () => { packageName?: string; objects?: Record<string, unknown> } | null
    >(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    hasClass: mockedModules.hasClass,
    registerFromManifest: mockedModules.registerFromManifest,
  },
}));

vi.mock('@happyvertical/smrt-core/manifest', () => ({
  ManifestManager: class {
    loadLocal() {
      return mockedModules.loadLocal();
    }
  },
}));

describe('manifest-registration logging (#2895)', () => {
  let root: string;

  beforeEach(() => {
    mockedModules.hasClass.mockReset();
    mockedModules.hasClass.mockReturnValue(false);
    mockedModules.registerFromManifest.mockReset();
    mockedModules.loadLocal.mockReset();
    // No local manifest -- exercise only the discovered-package path.
    mockedModules.loadLocal.mockReturnValue(null);
    root = mkdtempSync(join(tmpdir(), 'smrt-vitest-manifest-logging-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({}, null, 2));
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emits zero per-package lines and exactly one summary across two calls when quiet', async () => {
    mockedModules.loadLocal.mockReturnValue({
      packageName: '@happyvertical/smrt-core',
      objects: { Widget: {} },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await setupSmrtManifests({
      root,
      verbose: false,
      packages: ['@happyvertical/smrt-core'],
    });
    await setupSmrtManifests({
      root,
      verbose: false,
      packages: ['@happyvertical/smrt-core'],
    });

    const perPackageLines = logSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes('Loaded') &&
        String(call[0]).includes('classes'),
    );
    const summaryLines = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes('Loaded manifests from'),
    );

    expect(perPackageLines).toHaveLength(0);
    expect(summaryLines).toHaveLength(1);
  });

  it('emits per-package lines when verbose: true', async () => {
    mockedModules.loadLocal.mockReturnValue({
      packageName: '@happyvertical/smrt-core',
      objects: { Widget: {} },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await setupSmrtManifests({
      root,
      verbose: true,
      packages: ['@happyvertical/smrt-core'],
    });

    const perPackageLines = logSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes('Loaded') &&
        String(call[0]).includes('classes'),
    );
    expect(perPackageLines.length).toBeGreaterThan(0);
  });

  it('emits per-package lines when SMRT_VERBOSE=true even with verbose: false', async () => {
    mockedModules.loadLocal.mockReturnValue({
      packageName: '@happyvertical/smrt-core',
      objects: { Widget: {} },
    });
    vi.stubEnv('SMRT_VERBOSE', 'true');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await setupSmrtManifests({
      root,
      verbose: false,
      packages: ['@happyvertical/smrt-core'],
    });

    const perPackageLines = logSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes('Loaded') &&
        String(call[0]).includes('classes'),
    );
    expect(perPackageLines.length).toBeGreaterThan(0);
  });
});
