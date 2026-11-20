import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AppHost, bundledWorkerUrl, MemoryVersionStore } from './index.ts';

// The bundle exists after the package build (`tools/bundle-worker.mjs`). The
// whole engine suite also runs against it: `pnpm test:bundled-worker`.
const root = fileURLToPath(new URL('../..', import.meta.url));
// Build it fresh when the compiled engine is there (the package build leaves
// both), so the test never judges a stale bundle.
if (existsSync(join(root, 'dist/engine/app-worker.js')))
  spawnSync(process.execPath, [join(root, 'tools/bundle-worker.mjs')], {
    stdio: 'ignore',
  });
const bundle = bundledWorkerUrl();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!bundle)('bundled worker (#5213)', () => {
  it('is found from a host build that inlines the engine, via the package URL', () => {
    // An adapter-node server inlines the engine into build/server/chunks/...,
    // where import.meta.url no longer sits next to the package's dist/.
    const inlined = new URL(
      '../../build/server/chunks/chunks/App2.js',
      import.meta.url,
    );
    expect(bundledWorkerUrl(inlined)).toBeNull();
    const published = new URL(
      '../../dist/engine/app-worker.js',
      import.meta.url,
    );
    expect(bundledWorkerUrl(published)?.href).toBe(bundle?.href);
  });

  it('serves an app, keeping model names (no identifier mangling)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-bundle-'));
    dirs.push(dir);
    const host = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      workerUrl: bundle as URL,
    });
    try {
      for (const name of ['Chore', 'Chorus'])
        await host.execute(
          { type: 'defineModel', name, fields: { title: { type: 'text' } } },
          { author: 't' },
        );
      await host.create('Chore', { title: 'a' });
      await host.create('Chorus', { title: 'b' });
      expect(await host.list('Chore')).toHaveLength(1);
      expect(Object.keys(host.describe().models).sort()).toEqual([
        'Chore',
        'Chorus',
      ]);
    } finally {
      await host.close();
    }
  });

  it('bundle mode (SMRT_APP_SHELL_WORKER=bundle) runs an app: one write, one read, on the bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-bundle-mode-'));
    dirs.push(dir);
    const before = process.env.SMRT_APP_SHELL_WORKER;
    process.env.SMRT_APP_SHELL_WORKER = 'bundle';
    let host: AppHost | undefined;
    try {
      host = await AppHost.open(dir, { store: new MemoryVersionStore() });
    } finally {
      if (before === undefined) delete process.env.SMRT_APP_SHELL_WORKER;
      else process.env.SMRT_APP_SHELL_WORKER = before;
    }
    try {
      // The host chose the bundle (no workerUrl given) ...
      const url = (host as unknown as { workerUrl: URL }).workerUrl;
      expect(fileURLToPath(url)).toBe(fileURLToPath(bundle as URL));
      await host.execute(
        {
          type: 'defineModel',
          name: 'Chore',
          fields: { title: { type: 'text' } },
        },
        { author: 't' },
      );
      await host.create('Chore', { title: 'written' });
      expect((await host.list('Chore')).map((r) => r.title)).toEqual([
        'written',
      ]);
    } finally {
      await host.close();
    }
  });

  it('the worker thread really loads the bundle, not the engine modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-bundle-loads-'));
    dirs.push(dir);
    const log = join(dir, 'loads.log');
    writeFileSync(log, '');
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        join(root, 'test-support/load-recorder.mjs'),
        join(root, 'test-support/worker-loads-child.ts'),
        fileURLToPath(bundle as URL),
        dir,
        'plain',
      ],
      {
        env: { ...process.env, SMRT_LOAD_LOG: log },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    expect(r.status, r.stderr.slice(-2000)).toBe(0);
    const urls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(urls.some((u) => u.includes('/worker-bundle/'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/engine/app-runtime.ts'))).toBe(false);
    expect(urls.some((u) => u.endsWith('/engine/app-runtime.js'))).toBe(false);
  }, 150_000);
});
