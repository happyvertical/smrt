/**
 * `DATABASE_URL`/`DATABASE_TYPE` as the CLI database fallback (#3410 item 2):
 * the precedence rule in-process, then `smrt db:migrate` as a real process
 * the way `smrt app setup` runs it (environment only, no forwarded config).
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  clearCache,
  getPackageConfig,
  setConfig,
} from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLI_CONFIG } from '../config.js';
import { applyDatabaseEnvironment } from '../database-environment.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceEntry = join(packageRoot, 'src', 'index.ts');
const tsxLoader = pathToFileURL(
  join(packageRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const PASSWORD = 'pg-password-must-never-print';
const roots: string[] = [];

afterEach(() => {
  clearCache();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function effectiveDatabase() {
  return getPackageConfig('cli', DEFAULT_CLI_CONFIG).database;
}

describe('applyDatabaseEnvironment precedence', () => {
  it('uses DATABASE_URL and DATABASE_TYPE when no config layer names a database', async () => {
    expect(
      await applyDatabaseEnvironment({
        DATABASE_URL: '/data/app.sqlite',
        DATABASE_TYPE: 'sqlite',
      }),
    ).toBe('environment');
    expect(effectiveDatabase()).toEqual({
      type: 'sqlite',
      url: '/data/app.sqlite',
    });
  });

  it.each([
    ['postgres://u@db.example/app', undefined, 'postgres'],
    ['postgresql://u@db.example/app', undefined, 'postgres'],
    ['./dev.db', undefined, 'sqlite'],
    ['file:./dev.db', undefined, 'sqlite'],
    ['postgres://u@db.example/app', 'PostgreSQL', 'postgres'],
  ])('derives the engine for %s (DATABASE_TYPE %s)', async (url, type, expected) => {
    await applyDatabaseEnvironment({ DATABASE_URL: url, DATABASE_TYPE: type });
    expect(effectiveDatabase()).toEqual({ type: expected, url });
  });

  it('never lets the environment retarget a configured database', async () => {
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: './dev.db' } } },
    } as never);
    expect(
      await applyDatabaseEnvironment({
        DATABASE_URL: 'postgres://u@elsewhere/app',
        DATABASE_TYPE: 'postgres',
      }),
    ).toBe('config');
    expect(effectiveDatabase()).toEqual({ type: 'sqlite', url: './dev.db' });
  });

  it('keeps a configured engine and only fills in the URL', async () => {
    setConfig({
      packages: { cli: { database: { type: 'postgres' } } },
    } as never);
    await applyDatabaseEnvironment({
      DATABASE_URL: 'postgres://u@db.example/app',
      DATABASE_TYPE: 'sqlite',
    });
    expect(effectiveDatabase()).toEqual({
      type: 'postgres',
      url: 'postgres://u@db.example/app',
    });
  });

  it('ignores an empty URL and refuses an unknown engine without echoing the URL', async () => {
    expect(await applyDatabaseEnvironment({ DATABASE_URL: '  ' })).toBe('none');
    expect(await applyDatabaseEnvironment({})).toBe('none');
    const warn = vi.fn();
    expect(
      await applyDatabaseEnvironment(
        {
          DATABASE_URL: `mysql://root:${PASSWORD}@db/app`,
          DATABASE_TYPE: 'mysql',
        },
        warn,
      ),
    ).toBe('invalid-environment');
    expect(effectiveDatabase().url).toBe(':memory:');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('DATABASE_TYPE');
    expect(warn.mock.calls[0][0]).not.toContain(PASSWORD);
  });
});

describe('smrt db:migrate from the environment (real process)', () => {
  function project(): string {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), 'smrt-db-env-')),
    );
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'db-env-app', type: 'module' }),
    );
    // A config that, like the template's, says nothing about the database.
    writeFileSync(
      join(root, 'smrt.config.mjs'),
      'export default { runtime: { profile: "local" } };\n',
    );
    // A built project with no local objects that consumes one small package.
    mkdirSync(join(root, '.smrt'));
    writeFileSync(
      join(root, '.smrt', 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        timestamp: 0,
        packageName: 'db-env-app',
        packageVersion: '0.0.0',
        moduleType: 'smrt',
        smrtDependencies: ['@happyvertical/smrt-tenancy'],
        objects: {},
      }),
    );
    mkdirSync(join(root, 'node_modules', '@happyvertical'), {
      recursive: true,
    });
    symlinkSync(
      resolve(packageRoot, '..', 'tenancy'),
      join(root, 'node_modules', '@happyvertical', 'smrt-tenancy'),
    );
    // app-runtime owns creating the data root; the migration only opens it.
    mkdirSync(join(root, 'data'));
    return root;
  }

  function smrt(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
    const environment = { ...process.env, ...env };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete environment[key];
    }
    return spawnSync(
      process.execPath,
      ['--import', tsxLoader, sourceEntry, ...args],
      { cwd, env: environment, encoding: 'utf8', timeout: 120_000 },
    );
  }

  it('migrates the database DATABASE_URL names, as smrt app setup exports it', () => {
    const root = project();
    const database = join(root, 'data', 'app.sqlite');
    const result = smrt(root, ['db:migrate', '--verbose'], {
      DATABASE_URL: database,
      DATABASE_TYPE: 'sqlite',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain('Database configuration required');
    expect(result.stdout).toContain('Database type: sqlite');
    expect(result.status, output).toBe(0);
    expect(existsSync(database)).toBe(true);
  });

  it('still requires a database when neither config nor environment names one', () => {
    const root = project();
    const result = smrt(root, ['db:migrate'], {
      DATABASE_URL: undefined,
      DATABASE_TYPE: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Database configuration required');
  });

  it('never prints the credential of an environment URL', () => {
    const root = project();
    const result = smrt(root, ['db:migrate', '--verbose'], {
      // Nothing listens on port 1: the run fails after resolving the URL.
      DATABASE_URL: `postgres://smrt:${PASSWORD}@127.0.0.1:1/app`,
      DATABASE_TYPE: undefined,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain('Database configuration required');
    expect(result.stdout).toContain('Database type: postgres');
    expect(output).not.toContain(PASSWORD);
  });
});
