/**
 * Regression test for #1378: the smrtPlugin file-watcher handlers must not let
 * a mid-edit scan error escape as an unhandled promise rejection (which can
 * crash the dev server). Each `watcher.on(...)` handler is wrapped in try/catch
 * and logs via console.error.
 *
 * We drive `configureServer` with a minimal mock devServer whose `watcher` is a
 * real EventEmitter, then invoke the registered `change`/`add`/`unlink`
 * handlers directly. The scan is forced to fail by placing a MALFORMED source
 * file in the project root: the OXC scanner reports a parse error, so
 * scanAndGenerateManifest (via scanWithOxc) throws. The handler must swallow it
 * and log via console.error instead of leaking an unhandled rejection.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtPlugin } from './index.js';

describe('smrtPlugin watcher error guard (#1378)', () => {
  let testDir: string | null = null;
  let originalCwd: string | null = null;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // projectRoot defaults to process.cwd(); chdir into a temp dir so the scan
    // targets it. A MALFORMED .ts file makes the OXC scanner report a parse
    // error, which scanWithOxc turns into a thrown Error — the deterministic
    // failure the watcher handler must catch.
    testDir = mkdtempSync(join(tmpdir(), 'smrt-watcher-guard-'));
    mkdirSync(join(testDir, 'src'), { recursive: true });
    // Matches the default include glob (src/**/*.ts) so shouldRescan() is true.
    writeFileSync(
      join(testDir, 'src', 'thing.ts'),
      'export class @@@ { not valid typescript ((( \n',
    );
    originalCwd = process.cwd();
    process.chdir(testDir);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = null;
    }
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = null;
    }
  });

  function buildMockServer(watcher: EventEmitter) {
    return {
      watcher,
      middlewares: { use: () => {} },
      config: { root: testDir as string },
      moduleGraph: { getModuleById: () => undefined },
      reloadModule: () => {},
      transformIndexHtml: async (_url: string, html: string) => html,
    };
  }

  it('swallows a scan failure in the "change" handler and logs it', async () => {
    const watcher = new EventEmitter();
    const plugin: any = smrtPlugin({ watch: true, hmr: true });

    // configureServer registers the watcher handlers synchronously.
    plugin.configureServer(buildMockServer(watcher));

    const changeListeners = watcher.listeners('change');
    expect(changeListeners.length).toBeGreaterThan(0);
    const changeHandler = changeListeners[0] as (file: string) => Promise<void>;

    // The handler returns a promise; the guard means it must RESOLVE even
    // though the underlying scan rejects.
    await expect(changeHandler('src/thing.ts')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to rescan after change in'),
      expect.anything(),
    );
  });

  it('swallows a scan failure in the "add" handler and logs it', async () => {
    const watcher = new EventEmitter();
    const plugin: any = smrtPlugin({ watch: true, hmr: true });
    plugin.configureServer(buildMockServer(watcher));

    const addHandler = watcher.listeners('add')[0] as (
      file: string,
    ) => Promise<void>;
    expect(addHandler).toBeDefined();

    await expect(addHandler('src/thing.ts')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to rescan after adding'),
      expect.anything(),
    );
  });

  it('swallows a scan failure in the "unlink" handler and logs it', async () => {
    const watcher = new EventEmitter();
    const plugin: any = smrtPlugin({ watch: true, hmr: true });
    plugin.configureServer(buildMockServer(watcher));

    const unlinkHandler = watcher.listeners('unlink')[0] as (
      file: string,
    ) => Promise<void>;
    expect(unlinkHandler).toBeDefined();

    await expect(unlinkHandler('src/thing.ts')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to rescan after removing'),
      expect.anything(),
    );
  });
});
