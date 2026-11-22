import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// #5214: the reports package is only for report paths. A worker that served
// reads and writes must not have loaded it (about 3 MiB of heap per worker).
const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function loadedModules(mode: string, entry?: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'engine-loads-'));
  dirs.push(dir);
  const log = join(dir, 'loads.log');
  writeFileSync(log, '');
  const worker =
    entry ?? fileURLToPath(new URL('./app-worker.ts', import.meta.url));
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      join(root, 'test-support/load-recorder.mjs'),
      join(root, 'test-support/worker-loads-child.ts'),
      worker,
      dir,
      mode,
    ],
    {
      env: { ...process.env, SMRT_LOAD_LOG: log },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  expect(r.status, r.stderr.slice(-2000)).toBe(0);
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}
const reports = (urls: string[]) =>
  urls.filter((u) => /\/packages\/reports\/|smrt-reports/.test(u));

describe('the worker loads the reports package only for reports (#5214)', () => {
  it('a worker that served only reads and writes has not loaded it', () => {
    const urls = loadedModules('plain');
    // The worker really ran (the control below proves the log sees reports).
    expect(urls.some((u) => u.endsWith('/engine/app-runtime.ts'))).toBe(true);
    expect(reports(urls)).toEqual([]);
  }, 150_000);

  it('does load it when a report runs (the log can see it)', () => {
    expect(reports(loadedModules('report')).length).toBeGreaterThan(0);
  }, 150_000);
});
