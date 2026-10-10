/**
 * `smrt app` as a real process (#3371): raw argument passthrough to the
 * application's Vite CLI, `.env` precedence, MCP Apps validation before a
 * build, the stderr error envelope, and signal delivery through `bin/smrt.js`.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const sourceEntry = join(packageRoot, 'src', 'index.ts');
const binEntry = join(packageRoot, 'bin', 'smrt.js');
const distEntry = join(packageRoot, 'dist', 'index.js');
// Absolute, because the child's cwd is an application without tsx installed.
const tsxLoader = pathToFileURL(
  join(packageRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function hasCleanAncestors(directory: string): boolean {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules'))) return false;
    if (dirname(current) === current) return true;
  }
}

function application(viteBin = './bin/vite.mjs', viteSource?: string): string {
  const parent = [tmpdir(), homedir()]
    .map((directory) => realpathSync(directory))
    .find(hasCleanAncestors);
  if (!parent)
    throw new Error(
      'Choose a TMPDIR with no ancestor node_modules directories',
    );
  const root = realpathSync(mkdtempSync(join(parent, 'smrt-app-process-')));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'process-app', type: 'module' }),
  );
  const viteRoot = join(root, 'node_modules', 'vite');
  mkdirSync(join(viteRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(viteRoot, 'package.json'),
    JSON.stringify({
      name: 'vite',
      type: 'module',
      exports: { './package.json': './package.json' },
      bin: { vite: viteBin },
    }),
  );
  writeFileSync(
    join(viteRoot, 'bin', 'vite.mjs'),
    viteSource ??
      'process.stdout.write(JSON.stringify({ appId: process.env.SMRT_APP_ID, dataDirectory: process.env.SMRT_DATA_DIR, args: process.argv.slice(2) }));',
  );
  return root;
}

function smrt(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(
    process.execPath,
    ['--import', tsxLoader, sourceEntry, 'app', ...args],
    { cwd, env, encoding: 'utf8', timeout: 60_000 },
  );
}

describe('smrt app dev/build/vite', () => {
  it('loads .env without overriding the shell and passes arguments verbatim', () => {
    const app = application();
    writeFileSync(
      join(app, '.env'),
      'SMRT_APP_ID=file-app\nSMRT_DATA_DIR=data-root\n',
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      SMRT_APP_ID: 'shell-app',
    };
    delete environment.SMRT_DATA_DIR;
    const result = smrt(
      app,
      ['dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
      environment,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      appId: 'shell-app',
      dataDirectory: 'data-root',
      args: ['dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    });

    rmSync(join(app, '.env'));
    const version = smrt(app, ['vite', '--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout).args).toEqual(['--version']);
  });

  it('binds dev to the loopback host and port the onboarding URL names (#3410 item 3)', () => {
    const app = application();
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.PORT;
    const args = (argv: string[], env = environment) => {
      const result = smrt(app, argv, env);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).args;
    };
    // Vite's own default is `localhost`, which resolves to [::1] first.
    expect(args(['dev'])).toEqual(['dev', '--host', '127.0.0.1']);
    expect(
      args(['dev', '--strictPort'], { ...environment, PORT: '6123' }),
    ).toEqual(['dev', '--strictPort', '--host', '127.0.0.1', '--port', '6123']);
    // PORT from the app's .env, like HOST/PORT in the template's .env.example.
    writeFileSync(join(app, '.env'), 'PORT=6124\n');
    expect(args(['dev'])).toEqual([
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      '6124',
    ]);
    rmSync(join(app, '.env'));
    // An explicit choice is passed through untouched.
    expect(
      args(['dev', '--host', '0.0.0.0', '--port=7000'], {
        ...environment,
        PORT: '6123',
      }),
    ).toEqual(['dev', '--host', '0.0.0.0', '--port=7000']);
    expect(args(['dev', '--host=::1'])).toEqual(['dev', '--host=::1']);
    // `smrt app vite` stays verbatim.
    expect(args(['vite', 'dev'])).toEqual(['dev']);
  });

  it('validates ./mcp-apps before building and stops on findings', () => {
    const app = application();
    const plain = smrt(app, ['build', '--mode', 'production']);
    expect(plain.status, plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout).args).toEqual([
      'build',
      '--mode',
      'production',
    ]);

    mkdirSync(join(app, 'mcp-apps'));
    const invalid = smrt(app, ['build']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('plugin-missing');
    expect(invalid.stderr).toContain(
      'Error: MCP Apps package validation failed',
    );
    expect(invalid.stdout).toBe('');
  });

  it('refuses a missing or escaping Vite CLI', () => {
    const escaping = application('../../outside.mjs');
    const unsafe = smrt(escaping, ['dev']);
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toBe(
      's-m-r-t Vite launcher: The installed Vite package declares an unsafe CLI path.\n',
    );
    const missing = application();
    rmSync(join(missing, 'node_modules'), { recursive: true });
    const absent = smrt(missing, ['dev']);
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain(
      's-m-r-t Vite launcher: Could not resolve the installed Vite package',
    );
    const noBin = application();
    rmSync(join(noBin, 'node_modules', 'vite', 'bin'), { recursive: true });
    const noCli = smrt(noBin, ['dev']);
    expect(noCli.status).toBe(1);
    expect(noCli.stderr).toBe(
      's-m-r-t Vite launcher: The installed Vite package CLI is missing; reinstall dependencies.\n',
    );
  });
});

describe('child process output (R2)', () => {
  it.skipIf(!existsSync(distEntry))(
    'a failing real smrt db:migrate child never prints the database credentials',
    () => {
      const app = application();
      writeFileSync(
        join(app, 'smrt.config.js'),
        `export default {
          runtime: { profile: 'self-hosted' },
          packages: { cli: { database: { type: 'postgres', url: process.env.DATABASE_URL }, verbose: true } },
        };\n`,
      );
      mkdirSync(join(app, '.smrt'));
      const usersManifest = join(
        packageRoot,
        'node_modules',
        '@happyvertical',
        'smrt-users',
        'dist',
        'manifest.json',
      );
      writeFileSync(
        join(app, '.smrt', 'manifest.json'),
        readFileSync(usersManifest),
      );
      const result = smrt(app, ['migrate'], {
        ...process.env,
        XDG_STATE_HOME: join(app, '..', `${basename(app)}-state`),
        DATABASE_URL:
          'postgresql://owner:SENTINEL-PASSWORD-7731@127.0.0.1:1/app?password=SENTINEL-QUERY-7731',
      });
      rmSync(join(app, '..', `${basename(app)}-state`), {
        recursive: true,
        force: true,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      // The child really reached the database (and printed about it).
      expect(output).toContain('Connected to postgresql://owner:***@');
      expect(output).toContain('Migration failed');
      expect(output).not.toContain('SENTINEL');
    },
  );
});

describe('smrt app process contract', () => {
  it('writes only the JSON envelope to stderr and exits 1 on failure', () => {
    const app = application();
    const result = smrt(app, ['launch']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 1,
      status: 'error',
      code: 'operation-failed',
      message: 'Unknown app operation: launch',
      recovery: 'Run pnpm app:doctor and follow its recovery instructions.',
      secretValuesIncluded: false,
    });
  });

  it('dispatches through bin/smrt.js', () => {
    const app = application();
    const result = spawnSync(process.execPath, [binEntry, 'app', 'help'], {
      cwd: app,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: smrt app <operation> [args]');
  });

  it.skipIf(!existsSync(distEntry))(
    'delivers SIGTERM to the running command through the built bin/smrt.js',
    async () => {
      const app = application(
        './bin/vite.mjs',
        `process.on('SIGTERM', () => { process.stdout.write('graceful'); process.exit(0); });
         process.stdout.write('ready');
         setInterval(() => {}, 1000);`,
      );
      const child = spawn(process.execPath, [binEntry, 'app', 'vite'], {
        cwd: app,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output === 'ready') child.kill('SIGTERM');
      });
      const code = await new Promise<number | null>((resolveExit) =>
        child.on('exit', (exitCode) => resolveExit(exitCode)),
      );
      expect(output).toBe('readygraceful');
      expect(code).toBe(0);
    },
  );
});
