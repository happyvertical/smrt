/**
 * Issue #4128: `smrtVitestPlugin()` writes its test manifest to a per-run
 * snapshot it owns, publishes that path through core's environment contract,
 * and prunes only snapshots whose run has ended.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'vitest/config';
import {
  SMRT_TEST_MANIFEST_PATHS_ENV_KEY as CORE_ENV_KEY,
  resolveActiveTestManifestPath,
} from '../../../core/src/manifest/test-artifacts.js';
import {
  resolveTestRunManifestPath,
  SMRT_TEST_MANIFEST_PATHS_ENV_KEY,
  SMRT_TEST_RUNS_DIR,
  smrtVitestPlugin,
} from '../index.js';
import { getTestManifestPath } from '../test-db.js';

const roots: string[] = [];
let savedEnv: string | undefined;

function fixtureRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-vitest-4128-')));
  roots.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@test/isolation', type: 'module' }),
  );
  writeFileSync(join(dir, 'src/plain.ts'), 'export const plain = 1;');
  return dir;
}

async function invokeConfigResolved(plugin: Plugin): Promise<void> {
  const hook = plugin.configResolved;
  if (!hook) throw new Error('smrtVitestPlugin has no configResolved hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  // This fixture supplies only the resolved fields the hook reads.
  await handler.call({} as never, { plugins: [] } as never);
}

function seedRun(
  dir: string,
  name: string,
  owner: { pid: number; hostname: string; startedAt: number },
): string {
  const runDir = join(dir, SMRT_TEST_RUNS_DIR, name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'owner.json'), JSON.stringify(owner));
  writeFileSync(join(runDir, 'manifest.json'), '{"objects":{}}');
  return runDir;
}

beforeEach(() => {
  savedEnv = process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined)
    delete process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY];
  else process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY] = savedEnv;
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('test run manifest snapshot', () => {
  it('publishes the same environment key core reads', () => {
    expect(SMRT_TEST_MANIFEST_PATHS_ENV_KEY).toBe(CORE_ENV_KEY);
  });

  it('owns one stable per-process path under .smrt/test-runs, apart from production paths', () => {
    const dir = fixtureRoot();
    const snapshot = resolveTestRunManifestPath(dir);
    expect(resolveTestRunManifestPath(`${dir}/`)).toBe(snapshot);
    expect(
      snapshot.startsWith(join(dir, SMRT_TEST_RUNS_DIR, `${process.pid}-`)),
    ).toBe(true);
    expect(snapshot).not.toBe(join(dir, '.smrt/manifest.json'));
  });

  it('generates only the snapshot and registers it for workers', async () => {
    const dir = fixtureRoot();
    await invokeConfigResolved(smrtVitestPlugin({ root: dir }));
    const snapshot = resolveTestRunManifestPath(dir);
    expect(resolveActiveTestManifestPath(dir)).toBe(snapshot);
    expect(JSON.parse(readFileSync(snapshot, 'utf8')).artifactPurpose).toBe(
      'test',
    );
    expect(existsSync(join(dir, '.smrt/manifest.json'))).toBe(false);
    expect(existsSync(join(dir, '.smrt/smrt-knowledge.json'))).toBe(false);
    expect(existsSync(join(dir, 'dist/manifest.json'))).toBe(false);
  });

  it('getTestManifestPath fails loudly when the registered snapshot was removed mid-run', async () => {
    const dir = fixtureRoot();
    await invokeConfigResolved(smrtVitestPlugin({ root: dir }));
    expect(getTestManifestPath(dir)).toBe(resolveTestRunManifestPath(dir));
    rmSync(join(dir, '.smrt'), { recursive: true, force: true });
    expect(() => getTestManifestPath(dir)).toThrow(/is missing/);
  });

  it('does not register a snapshot when manifest generation is disabled', async () => {
    const dir = fixtureRoot();
    await invokeConfigResolved(
      smrtVitestPlugin({ root: dir, generateManifest: false }),
    );
    expect(resolveActiveTestManifestPath(dir)).toBeNull();
  });

  it('prunes only snapshots whose run has ended', async () => {
    const dir = fixtureRoot();
    const exited = spawnSync(process.execPath, ['-e', '']);
    expect(exited.pid).toBeGreaterThan(0);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const ended = seedRun(dir, 'ended', {
      pid: exited.pid as number,
      hostname: hostname(),
      startedAt: now,
    });
    const live = seedRun(dir, 'live', {
      pid: process.ppid,
      hostname: hostname(),
      startedAt: now,
    });
    // A same-host run still alive after more than a day (a long watch or
    // `--ui` session) is never pruned.
    const liveLongRunning = seedRun(dir, 'live-long-running', {
      pid: process.ppid,
      hostname: hostname(),
      startedAt: now - 2 * day,
    });
    const unowned = join(dir, SMRT_TEST_RUNS_DIR, 'unowned-recent');
    mkdirSync(unowned, { recursive: true });
    const remoteRecent = seedRun(dir, 'remote-recent', {
      pid: 1,
      hostname: `${hostname()}-elsewhere`,
      startedAt: now,
    });
    const remoteStale = seedRun(dir, 'remote-stale', {
      pid: 1,
      hostname: `${hostname()}-elsewhere`,
      startedAt: now - 2 * day,
    });

    await invokeConfigResolved(smrtVitestPlugin({ root: dir }));

    expect(existsSync(ended)).toBe(false);
    expect(existsSync(remoteStale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(liveLongRunning)).toBe(true);
    expect(existsSync(unowned)).toBe(true);
    expect(existsSync(remoteRecent)).toBe(true);
    expect(existsSync(resolveTestRunManifestPath(dir))).toBe(true);
  });
});
