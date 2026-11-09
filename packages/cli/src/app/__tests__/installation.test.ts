/**
 * `smrt app installation` (#4704) end to end in-process against a real local
 * application: real storage custody, the real custody records, and the same
 * state root the command resolves.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initializeLocalApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAppCommand } from '../cli.js';

const ENV_KEYS = [
  'HOME',
  'SMRT_DATA_DIR',
  'XDG_STATE_HOME',
  'SMRT_APP_ID',
] as const;
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const lockPaths: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const lockPath of lockPaths.splice(0)) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${lockPath}${suffix}`, { force: true });
    }
    try {
      rmdirSync(dirname(lockPath));
    } catch {
      // Shared or already removed.
    }
  }
});

function trackLock(data: string) {
  const identity = platform() === 'darwin' ? data.toLowerCase() : data;
  lockPaths.push(
    join(
      realpathSync('/tmp'),
      `.smrt-${process.getuid?.()}`,
      createHash('sha256').update(identity).digest('hex').slice(0, 32),
      'initialization.sqlite',
    ),
  );
}

async function installation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-app-install-')));
  roots.push(root);
  const app = join(root, 'app');
  const home = join(root, 'home');
  mkdirSync(app);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'inst-app' }),
  );
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, 'state');
  delete process.env.SMRT_APP_ID;

  const use = (data: string) => {
    process.env.SMRT_DATA_DIR = data;
    trackLock(data);
  };
  const boot = async (data: string) => {
    use(data);
    const { runtime } = await initializeLocalApplicationRuntime({
      appId: 'inst-app',
      dataDirectory: data,
      sourceRoot: app,
      bindHost: '127.0.0.1',
      // Stands in for `smrt db:migrate`: the registered framework schema.
      prepareDatabase: async (db) => {
        await getTestDatabase({ db });
      },
    });
    await runtime.db.close?.();
  };
  const output = { stdout: [] as string[], stderr: [] as string[] };
  const run = async (data: string, argv: string[]) => {
    use(data);
    output.stdout.length = 0;
    output.stderr.length = 0;
    const code = await runAppCommand(['installation', ...argv], {
      cwd: app,
      io: {
        stdout: (text) => output.stdout.push(text),
        stderr: (text) => output.stderr.push(text),
      },
      dependencies: {
        resolveRuntime: async () =>
          resolveApplicationRuntime({ profile: 'local' }) as never,
      },
    });
    return {
      code,
      stdout: output.stdout.join(''),
      stderr: output.stderr.join(''),
    };
  };
  return { root, app, boot, run };
}

describe('smrt app installation', () => {
  it('reports status, and restores a moved installation only on explicit assertion', async () => {
    const { root, boot, run } = await installation();
    const origin = join(root, 'origin');
    await boot(origin);
    const seed = readFileSync(
      join(origin, 'secrets', 'application.secret'),
      'utf8',
    );

    const status = await run(origin, []);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      status: 'in-custody',
      epoch: 1,
      resolutions: [],
      secretValuesIncluded: false,
    });

    const moved = join(root, 'moved');
    cpSync(origin, moved, { recursive: true });
    chmodSync(moved, 0o700);
    const arrived = await run(moved, ['status']);
    expect(JSON.parse(arrived.stdout)).toMatchObject({
      status: 'arrived',
      resolutions: ['restore', 'reseed'],
    });

    const refused = await run(moved, ['restore']);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ status: 'error' });
    expect(refused.stderr).toContain('--origin-retired');

    const restored = await run(moved, ['restore', '--origin-retired']);
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      declaration: 'restore',
      epoch: 2,
      status: 'in-custody',
      effects: { identityChanged: false, seedKeyedTokensInvalidated: false },
    });
    expect(restored.stdout).not.toContain(seed.trim());
    await boot(moved);
  });

  it('re-seeds a duplicate copy and states the identity and token effects', async () => {
    const { root, boot, run } = await installation();
    const origin = join(root, 'origin');
    await boot(origin);
    const copy = join(root, 'copy');
    cpSync(origin, copy, { recursive: true });
    chmodSync(copy, 0o700);
    const seed = readFileSync(
      join(origin, 'secrets', 'application.secret'),
      'utf8',
    );

    // Destroying the seed is never the default.
    const unconfirmed = await run(copy, ['reseed']);
    expect(unconfirmed.code).toBe(1);
    expect(JSON.parse(unconfirmed.stderr)).toMatchObject({ status: 'error' });
    expect(unconfirmed.stderr).toContain('--confirm-destroy-seed');
    expect(
      readFileSync(join(copy, 'secrets', 'application.secret'), 'utf8'),
    ).toBe(seed);

    const reseeded = await run(copy, ['reseed', '--confirm-destroy-seed']);
    expect(reseeded.code).toBe(0);
    const outcome = JSON.parse(reseeded.stdout) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      declaration: 'reseed',
      status: 'in-custody',
      effects: {
        identityChanged: true,
        seedKeyedTokensInvalidated: true,
        mcpTokensRevoked: 0,
      },
    });
    expect(String(outcome.notice)).toContain('seed-keyed tokens');
    expect(reseeded.stdout).not.toContain(seed.trim());
    expect(
      readFileSync(join(copy, 'secrets', 'application.secret'), 'utf8'),
    ).not.toBe(seed);
    expect(
      readFileSync(join(origin, 'secrets', 'application.secret'), 'utf8'),
    ).toBe(seed);
    await boot(copy);
    await boot(origin);
  });

  it('recovers a lost seed from a backup and never recreates it silently', async () => {
    const { root, boot, run } = await installation();
    const data = join(root, 'data');
    await boot(data);
    const seedPath = join(data, 'secrets', 'application.secret');
    const backup = join(root, 'seed.backup');
    writeFileSync(backup, readFileSync(seedPath), { mode: 0o600 });
    rmSync(seedPath);

    await expect(boot(data)).rejects.toMatchObject({
      code: 'installation_seed_missing',
    });
    expect(existsSync(seedPath)).toBe(false);
    expect(JSON.parse((await run(data, ['status'])).stdout)).toMatchObject({
      status: 'seed-missing',
      resolutions: ['recover-seed', 'reseed'],
    });

    const recovered = await run(data, ['recover-seed', backup]);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      declaration: 'recover-seed',
      status: 'in-custody',
      effects: { identityChanged: false },
    });
    await boot(data);
  });

  it('retires an origin and rejects bad usage before touching state', async () => {
    const { root, boot, run } = await installation();
    const data = join(root, 'data');
    await boot(data);
    expect((await run(data, ['retire'])).code).toBe(0);
    await expect(boot(data)).rejects.toMatchObject({
      code: 'installation_unverified',
    });

    for (const argv of [
      ['frobnicate'],
      ['restore', '--bogus'],
      ['reseed', 'extra'],
      ['reseed', '--confirm-destroy-seed', 'extra'],
      ['restore', '--confirm-destroy-seed'],
      ['status', '--confirm-destroy-seed'],
      ['recover-seed'],
      ['status', '--origin-retired'],
    ]) {
      const failed = await run(data, argv);
      expect(failed.code, argv.join(' ')).toBe(1);
      expect(JSON.parse(failed.stderr)).toMatchObject({ status: 'error' });
    }
    expect(JSON.parse((await run(data, ['status'])).stdout)).toMatchObject({
      status: 'retired',
    });
    expect((await run(data, ['--help'])).stdout).toContain('Usage:');
  });
});
