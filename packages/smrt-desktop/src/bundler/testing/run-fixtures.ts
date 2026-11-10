/**
 * Test-only fixtures for the bundler orchestrator: a tiny application, a
 * declarative fake installer (no pnpm, no network), a fake Node distribution
 * built from generated headers, and a seams builder. Excluded from published
 * types with the rest of the testing fixtures.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nodeTarGz } from '../../testing/tar-fixtures.js';
import { machoThin, pe } from '../native/testing/native-fixtures.js';
import {
  type AcquireNodeBinaryOptions,
  acquireNodeBinary,
  nodeDistLayout,
} from '../node-dist.js';
import { type BundleOptionsInput, createBundlePlan } from '../options.js';
import { nodeTreeFs } from '../paths.js';
import type { PnpmRequest } from '../pnpm-runner.js';
import type { BundleSeams } from '../run.js';

export const NODE_VERSION = '26.8.1';

export interface PackageSpec {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  gypfile?: boolean;
  main?: string;
  /** Extra files, relative to the package directory. */
  files?: Record<string, string | Buffer>;
  /** Install under another package: `node_modules/<parent>/node_modules/...`. */
  nestedIn?: string;
}

export const DEFAULT_PACKAGES: PackageSpec[] = [
  {
    name: 'a',
    dependencies: { b: '^1.0.0', vite: '^8.0.0' },
    files: {
      'index.js': "import b from 'b';\nexport default b;\n",
      'index.d.ts': 'export default {};\n',
      'index.js.map': '{}',
      'README.md': '# a\n',
      LICENSE: 'MIT\n',
    },
  },
  {
    name: 'b',
    files: {
      'index.js': 'export default 1;\n',
      'prebuilds/darwin-arm64/b.node': machoThin({
        cpu: 'arm64',
        filetype: 8,
      }),
    },
  },
  {
    name: 'vite',
    version: '8.0.0',
    files: { 'index.js': 'export default 2;\n' },
  },
  {
    name: 'googleapis',
    version: '170.1.0',
    dependencies: { 'googleapis-common': '^8.0.0' },
    files: { 'index.js': "import 'googleapis-common';\n" },
  },
  {
    name: 'googleapis-common',
    version: '8.0.0',
    files: { 'index.js': 'export default 3;\n' },
  },
];

export interface FixtureOptions {
  packages?: PackageSpec[];
  /** Direct dependencies written to the app `package.json`. */
  dependencies?: Record<string, string>;
  /** Files under `build/`, relative paths. */
  buildFiles?: Record<string, string | Buffer>;
  config?: Record<string, unknown>;
  lockfile?: string;
  npmrc?: string;
  /** Written as the app's `pnpm-workspace.yaml`. */
  workspaceYaml?: string;
  envFile?: string;
  appManifest?: Record<string, unknown>;
  bridge?: string | Buffer;
}

export interface FakePnpmCall {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly hadNpmrc: boolean;
  /** The `.npmrc` text pnpm was given, if any. */
  readonly npmrc?: string;
  /** The `pnpm-workspace.yaml` text pnpm was given, if any. */
  readonly workspace?: string;
  /** The staged `package.json` pnpm was given. */
  readonly manifest: Record<string, unknown>;
}

export interface Fixture {
  readonly root: string;
  readonly appDir: string;
  readonly outDir: string;
  readonly bridgeFile: string;
  readonly cacheDir: string;
  readonly calls: FakePnpmCall[];
  /** Working directories `pnpmVersion` was asked to probe from. */
  readonly versionCwds: string[];
  plan(
    input?: Partial<BundleOptionsInput>,
  ): ReturnType<typeof createBundlePlan>;
  seams(overrides?: Partial<BundleSeams>): BundleSeams;
  cleanup(): void;
}

function put(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function installPackages(
  nodeModules: string,
  packages: readonly PackageSpec[],
): void {
  for (const spec of packages) {
    const base =
      spec.nestedIn === undefined
        ? join(nodeModules, ...spec.name.split('/'))
        : join(
            nodeModules,
            ...spec.nestedIn.split('/'),
            'node_modules',
            ...spec.name.split('/'),
          );
    put(
      join(base, 'package.json'),
      `${JSON.stringify(
        {
          name: spec.name,
          version: spec.version ?? '1.0.0',
          main: spec.main ?? 'index.js',
          type: 'module',
          ...(spec.dependencies ? { dependencies: spec.dependencies } : {}),
          ...(spec.optionalDependencies
            ? { optionalDependencies: spec.optionalDependencies }
            : {}),
          ...(spec.scripts ? { scripts: spec.scripts } : {}),
          ...(spec.gypfile ? { gypfile: true } : {}),
        },
        null,
        2,
      )}\n`,
    );
    for (const [rel, data] of Object.entries(spec.files ?? {})) {
      put(join(base, rel), data);
    }
  }
  // pnpm state and a `.bin` directory the normalisation step must drop.
  put(join(nodeModules, '.modules.yaml'), 'layoutVersion: 5\n');
  put(join(nodeModules, '.pnpm-workspace-state-v1.json'), '{}\n');
  put(join(nodeModules, '.bin', 'tool'), '#!/bin/sh\n');
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Create a fixture. Everything lives under one `mkdtemp` root; `cleanup()`
 * removes it. The fake installer materialises `packages` as a hoisted
 * `node_modules` in the staging install directory.
 */
export function createFixture(options: FixtureOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundle-run-')));
  const appDir = join(root, 'app');
  const outDir = join(root, 'dist', 'bundle');
  const bridgeFile = join(root, 'bridge.mjs');
  const cacheDir = join(root, 'cache');
  const calls: FakePnpmCall[] = [];
  const versionCwds: string[] = [];
  const packages = options.packages ?? DEFAULT_PACKAGES;

  mkdirSync(join(root, 'dist'), { recursive: true });
  put(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-app',
        version: '1.2.3',
        type: 'module',
        scripts: { postinstall: 'echo should-never-run' },
        dependencies: options.dependencies ?? {
          a: '^1.0.0',
          googleapis: '^170.0.0',
        },
        devDependencies: { vitest: '^4.0.0' },
        packageManager: 'pnpm@11.25.0',
        ...options.appManifest,
      },
      null,
      2,
    )}\n`,
  );
  put(
    join(appDir, 'pnpm-lock.yaml'),
    options.lockfile ??
      [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        '  a@1.0.0:',
        '    resolution: {integrity: sha512-AAAA}',
        '',
        '  b@1.0.0:',
        '    resolution: {integrity: sha512-BBBB}',
        '',
      ].join('\n'),
  );
  put(
    join(appDir, 'smrt-desktop.json'),
    `${JSON.stringify(
      {
        version: 1,
        productId: 'smrt-start',
        bundleId: 'com.happyvertical.smrt-start',
        displayName: 'SMRT Start',
        bridge: { envPrefix: 'SMRT_START', mcpPath: '/api/mcp' },
        ...options.config,
      },
      null,
      2,
    )}\n`,
  );
  for (const [rel, data] of Object.entries(
    options.buildFiles ?? {
      'index.js': "import a from 'a';\nconsole.log(a);\n",
      'client/app.js': 'export const client = true;\n',
    },
  )) {
    put(join(appDir, 'build', rel), data);
  }
  if (options.npmrc !== undefined) put(join(appDir, '.npmrc'), options.npmrc);
  if (options.workspaceYaml !== undefined) {
    put(join(appDir, 'pnpm-workspace.yaml'), options.workspaceYaml);
  }
  if (options.envFile !== undefined) put(join(appDir, '.env'), options.envFile);
  put(
    bridgeFile,
    options.bridge ??
      "import { stdin } from 'node:process';\nexport const bridge = stdin;\n",
  );

  const fakeRunPnpm = async (request: PnpmRequest) => {
    calls.push({
      cwd: request.cwd,
      args: [...request.args],
      env: { ...request.env },
      hadNpmrc: existsSync(join(request.cwd, '.npmrc')),
      ...(existsSync(join(request.cwd, '.npmrc'))
        ? { npmrc: readFileSync(join(request.cwd, '.npmrc'), 'utf8') }
        : {}),
      ...(existsSync(join(request.cwd, 'pnpm-workspace.yaml'))
        ? {
            workspace: readFileSync(
              join(request.cwd, 'pnpm-workspace.yaml'),
              'utf8',
            ),
          }
        : {}),
      manifest: JSON.parse(
        readFileSync(join(request.cwd, 'package.json'), 'utf8'),
      ),
    });
    installPackages(join(request.cwd, 'node_modules'), packages);
    return { exitCode: 0, output: '' };
  };

  const acquire = (acquireOptions: AcquireNodeBinaryOptions) => {
    const layout = nodeDistLayout(NODE_VERSION, acquireOptions.target);
    const platform = acquireOptions.target.nodePlatform;
    const arch = acquireOptions.target.nodeArch;
    const archive =
      layout.kind === 'exe'
        ? pe({ machine: arch === 'arm64' ? 'arm64' : 'x64' })
        : nodeTarGz(NODE_VERSION, platform, arch, {
            binary: machoThin({
              cpu: arch === 'arm64' ? 'arm64' : 'x86_64',
              filetype: 2,
            }),
          });
    const archivePath = join(root, `archive-${layout.cacheName}`);
    if (!existsSync(archivePath)) writeFileSync(archivePath, archive);
    return acquireNodeBinary({
      ...acquireOptions,
      archivePath,
      pins: { [NODE_VERSION]: { [layout.distFile]: sha256(archive) } },
    });
  };

  return {
    root,
    appDir,
    outDir,
    bridgeFile,
    cacheDir,
    calls,
    versionCwds,
    plan(input = {}) {
      return createBundlePlan({
        appDir,
        outDir,
        bridgeFile,
        target: 'aarch64-apple-darwin',
        nodeVersion: NODE_VERSION,
        nodeCache: cacheDir,
        ...input,
      });
    },
    seams(overrides = {}) {
      return {
        fs: nodeTreeFs,
        platform: process.platform,
        arch: 'arm64',
        env: { PATH: '/usr/bin:/bin', HOME: '/home/fixture' },
        toolVersion: '0.0.0-test',
        nodeVersion: NODE_VERSION,
        defaultNodeCacheDir: cacheDir,
        acquireNode: acquire,
        runPnpm: fakeRunPnpm,
        pnpmVersion: async (_env, cwd) => {
          versionCwds.push(cwd);
          return '11.25.0';
        },
        ...overrides,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** All regular files under `root`, as `relative path -> bytes`. */
export function readTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) visit(full, rel);
      else out.set(rel, readFileSync(full));
    }
  };
  visit(root, '');
  return out;
}

/** Names in `dir` starting with the bundler's staging prefix. */
export function stagingLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) =>
    name.startsWith('.smrt-desktop-bundle-'),
  );
}
