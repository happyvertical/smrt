import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBundleManifest } from '../install/bundle-manifest.js';
import {
  parseSidecarManifest,
  serializeSidecarManifest,
} from '../sidecar-manifest.js';
import { BUNDLE_STAGES, BundleError } from './errors.js';
import { machoThin } from './native/testing/native-fixtures.js';
import { nodeTreeFs, type TreeFs } from './paths.js';
import {
  BUNDLE_FILES_FILENAME,
  BUNDLE_REPORT_FILENAME,
  parseBundleReport,
} from './report.js';
import { runBundle } from './run.js';
import {
  createFixture,
  type Fixture,
  type FixtureOptions,
  readTree,
  sha256,
  stagingLeftovers,
} from './testing/run-fixtures.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const fixtures: Fixture[] = [];
function fixture(options?: FixtureOptions): Fixture {
  const created = createFixture(options);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const item of fixtures.splice(0)) item.cleanup();
});

async function failure(promise: Promise<unknown>): Promise<BundleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BundleError);
    return error as BundleError;
  }
  throw new Error('expected the bundle to fail');
}

function assertNothingLeft(item: Fixture): void {
  expect(existsSync(item.outDir)).toBe(false);
  expect(stagingLeftovers(join(item.root, 'dist'))).toEqual([]);
}

describe('runBundle layout', () => {
  it('produces the documented layout', async () => {
    const item = fixture();
    const result = await runBundle(await item.plan(), item.seams());

    const files = [...readTree(item.outDir).keys()];
    expect(files).toContain('binaries/smrt-start-node-aarch64-apple-darwin');
    expect(files).toContain('resources/sidecar-manifest.json');
    expect(files).toContain('resources/smrt-bundle.json');
    expect(files).toContain('resources/app/package.json');
    expect(files).toContain('resources/app/build/index.js');
    expect(files).toContain('resources/app/build/client/app.js');
    expect(files).toContain('resources/app/node_modules/a/index.js');
    expect(files).toContain('resources/app/node_modules/a/LICENSE');
    expect(files).toContain('resources/app/node_modules/b/index.js');
    expect(files).toContain('resources/bridge/smrt-mcp-bridge.mjs');
    expect(files).toContain('resources/licenses/node-LICENSE');
    expect(files).toContain('tauri.bundle.json');
    expect(files).toContain(BUNDLE_FILES_FILENAME);
    expect(files).toContain(BUNDLE_REPORT_FILENAME);
    expect(result.stages).toEqual(BUNDLE_STAGES.filter((s) => s !== 'measure'));

    // Pruned, removed and normalised content is gone.
    expect(files.some((f) => f.endsWith('.map'))).toBe(false);
    expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false);
    expect(files.some((f) => f.endsWith('README.md'))).toBe(false);
    expect(files.some((f) => f.includes('/.bin/'))).toBe(false);
    expect(files.some((f) => f.includes('.modules.yaml'))).toBe(false);
    expect(files.some((f) => f.includes('googleapis'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules/vite'))).toBe(false);

    const overlay = JSON.parse(
      readFileSync(join(item.outDir, 'tauri.bundle.json'), 'utf8'),
    );
    expect(overlay).toEqual({
      bundle: {
        externalBin: ['binaries/smrt-start-node'],
        resources: { 'resources/': './' },
      },
    });
    const appManifest = JSON.parse(
      readFileSync(join(item.outDir, 'resources/app/package.json'), 'utf8'),
    );
    expect(appManifest).toEqual({
      name: 'smrt-start',
      version: '1.2.3',
      private: true,
      type: 'module',
    });
  });

  it('writes the report with sizes, removed packages and natives', async () => {
    const item = fixture();
    const result = await runBundle(await item.plan(), item.seams());
    const report = parseBundleReport(
      readFileSync(join(item.outDir, BUNDLE_REPORT_FILENAME), 'utf8'),
    );
    expect(report).toEqual(result.report);
    expect(report.target).toBe('aarch64-apple-darwin');
    expect(report.product.productId).toBe('smrt-start');
    expect(report.node.version).toBe('26.8.1');
    expect(report.node.machine).toBe('arm64');
    expect(report.features.removedPackages.map((p) => p.name)).toEqual([
      'googleapis',
      'googleapis-common',
      'vite',
    ]);
    expect(report.packages.map((p) => p.name)).toEqual(['a', 'b']);
    expect(report.natives.map((n) => n.path)).toEqual([
      'binaries/smrt-start-node-aarch64-apple-darwin',
      'resources/app/node_modules/b/prebuilds/darwin-arm64/b.node',
    ]);
    expect(report.pruned.files).toBeGreaterThan(0);
    expect(report.pruned.removedPackageFiles).toBeGreaterThan(0);
    const { breakdown } = report.files;
    expect(
      breakdown.nodeBinary +
        breakdown.nodeModules +
        breakdown.appBuild +
        breakdown.other,
    ).toBe(report.files.bytes);
    expect(report.files.count).toBe(
      readFileSync(join(item.outDir, BUNDLE_FILES_FILENAME), 'utf8')
        .trimEnd()
        .split('\n').length,
    );
    expect(sha256(readFileSync(join(item.outDir, BUNDLE_FILES_FILENAME)))).toBe(
      report.files.listSha256,
    );
  });

  it('lists a sha256 for every file that matches its content', async () => {
    const item = fixture();
    await runBundle(await item.plan(), item.seams());
    const listed = readFileSync(
      join(item.outDir, BUNDLE_FILES_FILENAME),
      'utf8',
    )
      .trimEnd()
      .split('\n');
    const paths = listed.map((line) => line.slice(66));
    expect(paths).toEqual([...paths].sort());
    for (const line of listed) {
      const digest = line.slice(0, 64);
      const path = line.slice(66);
      expect(sha256(readFileSync(join(item.outDir, path)))).toBe(digest);
    }
    expect(paths.some((p) => p === BUNDLE_REPORT_FILENAME)).toBe(false);
  });

  it('writes manifests the contract parsers accept and that round-trip byte for byte', async () => {
    const item = fixture();
    await runBundle(await item.plan(), item.seams());
    const sidecarText = readFileSync(
      join(item.outDir, 'resources/sidecar-manifest.json'),
      'utf8',
    );
    const bundleText = readFileSync(
      join(item.outDir, 'resources/smrt-bundle.json'),
      'utf8',
    );
    const sidecar = parseSidecarManifest(sidecarText);
    const bundle = parseBundleManifest(bundleText);
    expect(serializeSidecarManifest(sidecar)).toBe(sidecarText);
    expect(bundle.node.executable).toBe(sidecar.executable);
    expect(bundle.node.executable).toBe('smrt-start-node');
    expect(bundle.target).toBe('aarch64-apple-darwin');
    expect(bundle.bridge).toMatchObject({
      entry: 'bridge/smrt-mcp-bridge.mjs',
      envPrefix: 'SMRT_START',
      mcpPath: '/api/mcp',
    });
    expect(sidecar.args).toEqual(['app/build/index.js']);
    expect(sidecarText.endsWith('\n')).toBe(true);
  });

  it('writes a sidecar manifest that neutralises NODE_OPTIONS and NODE_PATH', async () => {
    const item = fixture();
    await runBundle(await item.plan(), item.seams());
    const sidecar = parseSidecarManifest(
      readFileSync(
        join(item.outDir, 'resources/sidecar-manifest.json'),
        'utf8',
      ),
    );
    expect(sidecar.env).toEqual({
      NODE_ENV: 'production',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    });
  });

  it('names the Node binary with the .exe suffix and no license for a Windows target', async () => {
    const item = fixture();
    await runBundle(
      await item.plan({ target: 'x86_64-pc-windows-msvc' }),
      item.seams({ arch: 'x64' }),
    );
    const files = [...readTree(item.outDir).keys()];
    expect(files).toContain(
      'binaries/smrt-start-node-x86_64-pc-windows-msvc.exe',
    );
    expect(files).not.toContain('resources/licenses/node-LICENSE');
  });

  it('prunes foreign prebuild directories for the target', async () => {
    const item = fixture();
    const { report } = await runBundle(
      await item.plan({ target: 'x86_64-pc-windows-msvc' }),
      item.seams({ arch: 'x64' }),
    );
    expect(report.natives.map((n) => n.path)).toEqual([
      'binaries/smrt-start-node-x86_64-pc-windows-msvc.exe',
    ]);
  });

  it('refuses a macOS native when the target is Windows', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js': 'export {};\n',
            'addon.node': machoThin({ cpu: 'arm64', filetype: 8 }),
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    const error = await failure(
      runBundle(
        await item.plan({ target: 'x86_64-pc-windows-msvc' }),
        item.seams({ arch: 'x64' }),
      ),
    );
    expect(error.stage).toBe('natives');
    expect(error.exitCode).toBe(5);
    expect(error.failures).toEqual([
      {
        path: 'resources/app/node_modules/a/addon.node',
        reason: 'wrong_format',
      },
    ]);
    assertNothingLeft(item);
  });
});

describe('determinism', () => {
  it('produces identical files and report for identical inputs', async () => {
    const first = fixture();
    const second = fixture();
    // Same app content in two roots; different out dirs, caches and staging.
    await runBundle(await first.plan(), first.seams());
    await runBundle(await second.plan(), second.seams());
    const a = readTree(first.outDir);
    const b = readTree(second.outDir);
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [path, bytes] of a) {
      expect(bytes.equals(b.get(path) as Buffer), path).toBe(true);
    }
    expect(a.get(BUNDLE_REPORT_FILENAME)?.toString()).not.toMatch(
      /smrt-bundle-run-|\/tmp\/|\/var\//,
    );
  });

  it('orders the file list independently of readdir order', async () => {
    const first = fixture();
    const second = fixture();
    const shuffled: TreeFs = {
      ...nodeTreeFs,
      readdir: async (path) => (await nodeTreeFs.readdir(path)).reverse(),
    };
    await runBundle(await first.plan(), first.seams());
    await runBundle(await second.plan(), second.seams({ fs: shuffled }));
    expect(
      readFileSync(join(first.outDir, BUNDLE_FILES_FILENAME), 'utf8'),
    ).toBe(readFileSync(join(second.outDir, BUNDLE_FILES_FILENAME), 'utf8'));
  });

  it('sets every modification time to the epoch floor or SOURCE_DATE_EPOCH', async () => {
    const first = fixture();
    await runBundle(await first.plan(), first.seams());
    const stamp = statSync(
      join(first.outDir, 'resources/app/build/index.js'),
    ).mtimeMs;
    expect(stamp).toBe(315_532_800_000);
    expect(statSync(first.outDir).mtimeMs).toBe(315_532_800_000);

    const second = fixture();
    await runBundle(
      await second.plan(),
      second.seams({ sourceDateEpoch: 1_700_000_000 }),
    );
    expect(statSync(join(second.outDir, 'tauri.bundle.json')).mtimeMs).toBe(
      1_700_000_000_000,
    );
  });
});

describe('failure handling', () => {
  const stages = BUNDLE_STAGES.filter((stage) => stage !== 'measure');

  it.each(
    stages,
  )('fails at the %s stage and leaves no output and no staging', async (stage) => {
    const item = fixture();
    const error = await failure(
      runBundle(
        await item.plan(),
        item.seams({
          onStage: (name) => {
            if (name === stage) throw new Error('injected');
          },
        }),
      ),
    );
    expect(error.stage).toBe(stage);
    expect(error.code).toBe('internal');
    expect(error.exitCode).toBe(1);
    assertNothingLeft(item);
  });

  it('keeps staging only when asked, for debugging', async () => {
    const item = fixture();
    await failure(
      runBundle(
        await item.plan(),
        item.seams({
          keepStaging: true,
          onStage: (name) => {
            if (name === 'report') throw new Error('injected');
          },
        }),
      ),
    );
    expect(stagingLeftovers(join(item.root, 'dist'))).toHaveLength(1);
  });

  it('refuses a non-empty output directory that appears before publishing', async () => {
    const item = fixture();
    const error = await failure(
      runBundle(
        await item.plan(),
        item.seams({
          onStage: (name) => {
            if (name === 'publish') {
              mkdirSync(item.outDir);
              writeFileSync(join(item.outDir, 'keep.txt'), 'mine');
            }
          },
        }),
      ),
    );
    expect(error.code).toBe('out_dir_not_empty');
    expect(error.exitCode).toBe(3);
    expect(readFileSync(join(item.outDir, 'keep.txt'), 'utf8')).toBe('mine');
    expect(stagingLeftovers(join(item.root, 'dist'))).toEqual([]);
  });

  it('replaces an existing bundle only with force, moving it aside first', async () => {
    const item = fixture();
    mkdirSync(item.outDir);
    writeFileSync(join(item.outDir, 'old.txt'), 'old');
    const result = await runBundle(
      await item.plan({ force: true }),
      item.seams(),
    );
    expect(result.outDir).toBe(item.outDir);
    expect(existsSync(join(item.outDir, 'old.txt'))).toBe(false);
    expect(existsSync(join(item.outDir, 'tauri.bundle.json'))).toBe(true);
    expect(readdirSync(join(item.root, 'dist'))).toEqual(['bundle']);
  });

  it('fails a run without a bridge file before creating anything', async () => {
    const item = fixture();
    const plan = await item.plan({});
    const { bridgeFile: _omit, ...withoutBridge } = plan;
    const error = await failure(
      runBundle(withoutBridge as typeof plan, item.seams()),
    );
    expect(error.code).toBe('bridge_missing');
    expect(error.exitCode).toBe(3);
    assertNothingLeft(item);
  });

  it('classifies a failed install by its output without echoing it', async () => {
    const cases: [string, string, number][] = [
      [
        'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen',
        'lockfile_drift',
        4,
      ],
      [
        'ERR_PNPM_TARBALL_INTEGRITY  Got unexpected checksum',
        'integrity_failure',
        4,
      ],
      ['something went wrong with token=hunter2', 'pnpm_failed', 7],
    ];
    for (const [output, code, exit] of cases) {
      const item = fixture();
      const error = await failure(
        runBundle(
          await item.plan(),
          item.seams({
            runPnpm: async () => ({ exitCode: 1, output }),
          }),
        ),
      );
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(exit);
      expect(error.stage).toBe('install');
      expect(JSON.stringify(error)).not.toContain('hunter2');
      expect(error.message).not.toContain('hunter2');
      assertNothingLeft(item);
    }
  });

  it('never runs scripts: the staged package.json has none and argv is the frozen form', async () => {
    const item = fixture();
    await runBundle(await item.plan(), item.seams());
    const call = item.calls[0];
    expect(call?.args).toEqual([
      'install',
      '--frozen-lockfile',
      '--prod',
      '--ignore-scripts',
      '--os',
      'darwin',
      '--cpu',
      'arm64',
      '--config.node-linker=hoisted',
      '--config.side-effects-cache=false',
      '--config.package-import-method=copy',
      '--config.verify-store-integrity=true',
    ]);
    expect(call?.env.npm_config_ignore_scripts).toBe('true');
  });
});

describe('inputs and provenance', () => {
  it('rejects production dependencies that are not registry packages', async () => {
    const item = fixture({
      dependencies: { a: '^1.0.0', evil: 'github:someone/evil' },
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('unsupported_resolution');
    expect(error.stage).toBe('inputs');
    expect(error.subjects).toEqual(['evil']);
    assertNothingLeft(item);
  });

  it('rejects a lockfile package resolved from a tarball URL or git', async () => {
    const item = fixture({
      lockfile: [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        '  a@1.0.0:',
        '    resolution: {tarball: https://example.test/a-1.0.0.tgz}',
        '',
        '  b@1.0.0:',
        '    resolution: {integrity: sha512-BBBB}',
        '',
      ].join('\n'),
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('lockfile_non_registry');
    expect(error.exitCode).toBe(4);
    expect(error.subjects).toEqual(['a']);
    expect(JSON.stringify(error)).not.toContain('example.test');
  });

  it('records lockfile and package.json hashes', async () => {
    const item = fixture();
    const { report } = await runBundle(await item.plan(), item.seams());
    expect(report.inputs.packageJsonSha256).toBe(
      sha256(readFileSync(join(item.appDir, 'package.json'))),
    );
    expect(report.inputs.lockfileSha256).toBe(
      sha256(readFileSync(join(item.appDir, 'pnpm-lock.yaml'))),
    );
    expect(report.inputs.productConfigSha256).toBe(
      sha256(readFileSync(join(item.appDir, 'smrt-desktop.json'))),
    );
    expect(report.inputs.buildTreeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails a package with an install script and no prebuilt binary', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          scripts: { install: 'node-gyp rebuild' },
          files: { 'index.js': 'export default 1;\n' },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('build_step_required');
    expect(error.subjects).toEqual(['a']);
    expect(error.exitCode).toBe(5);
    assertNothingLeft(item);
  });

  it('allows an install script when the package ships a prebuilt addon', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          scripts: { install: 'node-gyp rebuild' },
          files: {
            'index.js': 'export default 1;\n',
            'build/Release/a.node': machoThin({ cpu: 'arm64', filetype: 8 }),
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    await runBundle(await item.plan(), item.seams());
    expect(
      existsSync(
        join(item.outDir, 'resources/app/node_modules/a/build/Release/a.node'),
      ),
    ).toBe(true);
  });

  it('allows the closed list of harmless postinstall packages', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          scripts: { postinstall: 'node install.js' },
          files: { 'index.js': 'export default 1;\n' },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
      config: { exclude: [] },
    });
    // `a` is not on the list, so this must fail; protobufjs-style names pass.
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('build_step_required');

    const ok = fixture({
      dependencies: { protobufjs: '^7.0.0' },
      packages: [
        {
          name: 'protobufjs',
          scripts: { postinstall: 'node scripts/postinstall' },
          files: { 'index.js': 'export default 1;\n' },
        },
      ],
      buildFiles: { 'index.js': 'export default 1;\n' },
    });
    await runBundle(await ok.plan(), ok.seams());
  });
});

describe('Node acquisition', () => {
  it('rejects a Node binary built for another architecture', async () => {
    const item = fixture();
    const seams = item.seams();
    const error = await failure(
      runBundle(await item.plan({ target: 'aarch64-apple-darwin' }), {
        ...seams,
        acquireNode: (options) =>
          seams.acquireNode({
            ...options,
            // Hand the verifier an x86_64 binary for an arm64 target.
            verifyBinary: async (binary) => {
              const wrong = machoThin({ cpu: 'x86_64', filetype: 2 });
              void binary;
              await options.verifyBinary?.(wrong);
            },
          }),
      }),
    );
    expect(error.code).toBe('binary_rejected');
    expect(error.exitCode).toBe(5);
    expect(error.stage).toBe('node');
    assertNothingLeft(item);
  });

  it('passes the cache, offline flag and archive through to acquisition', async () => {
    const item = fixture();
    let seen: Record<string, unknown> = {};
    const seams = item.seams();
    await runBundle(await item.plan({ offline: true }), {
      ...seams,
      acquireNode: (options) => {
        seen = { ...options };
        return seams.acquireNode(options);
      },
    });
    expect(seen.cacheDir).toBe(item.cacheDir);
    expect(seen.offline).toBe(true);
    expect(seen.version).toBe('26.8.1');
    expect(item.calls[0]?.args).toContain('--offline');
  });
});

describe('secrets', () => {
  it('fails when the build output contains a .env file', async () => {
    const item = fixture({
      buildFiles: { 'index.js': 'export {};\n', '.env': 'TOKEN=abc\n' },
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('secret_file');
    expect(error.stage).toBe('build_copy');
    expect(error.subjects).toEqual(['.env']);
    assertNothingLeft(item);
  });

  it('fails on a private key in the build output', async () => {
    const item = fixture({
      buildFiles: {
        'index.js': `export const k = "-----BEGIN ${'RSA'} PRIVATE KEY-----";\n`,
      },
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('secret_content');
    assertNothingLeft(item);
  });

  it('keeps a canary token out of the output, the report and the child environment', async () => {
    const canary = 'CANARY-7f3a91c2d4e85b60';
    const item = fixture({
      npmrc: `//registry.npmjs.org/:_authToken=${canary}-npmrc\n`,
      envFile: `SECRET=${canary}-dotenv\n`,
    });
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/fixture',
      NPM_TOKEN: `${canary}-env`,
      GITHUB_TOKEN: `${canary}-gh`,
      NODE_OPTIONS: `--require ${canary}-evil`,
      npm_config_ignore_scripts: 'false',
    };
    const result = await runBundle(await item.plan(), item.seams({ env }));

    // The .npmrc reached the install directory (private registries work) ...
    expect(item.calls[0]?.hadNpmrc).toBe(true);
    // ... but no canary reached pnpm's environment ...
    expect(JSON.stringify(item.calls[0]?.env)).not.toContain(canary);
    expect(item.calls[0]?.env.NODE_OPTIONS).toBeUndefined();
    expect(item.calls[0]?.env.npm_config_ignore_scripts).toBe('true');
    // ... or any byte of the output, including the report.
    for (const [path, bytes] of readTree(item.outDir)) {
      expect(bytes.includes(canary), path).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(readdirSync(item.outDir).some((n) => n.startsWith('.'))).toBe(false);
    const files = [...readTree(item.outDir).keys()];
    expect(files.some((f) => f.endsWith('.npmrc') || f.endsWith('.env'))).toBe(
      false,
    );
  });

  it('keeps a canary out of the error of a failed install', async () => {
    const canary = 'CANARY-0a1b2c3d4e5f';
    const item = fixture({ npmrc: `//r/:_authToken=${canary}\n` });
    const error = await failure(
      runBundle(
        await item.plan(),
        item.seams({
          env: { PATH: '/usr/bin', NPM_TOKEN: canary },
          runPnpm: async () => ({
            exitCode: 1,
            output: `fetch failed https://u:${canary}@registry.example`,
          }),
        }),
      ),
    );
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(`${error.message} ${error.subjects.join(' ')}`).not.toContain(
      canary,
    );
  });
});

describe('segmentation and imports', () => {
  it('fails when the build statically imports a removed package', async () => {
    const item = fixture({
      buildFiles: { 'index.js': "import { google } from 'googleapis';\n" },
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('removed_package_imported');
    expect(error.stage).toBe('scan');
    expect(error.exitCode).toBe(5);
    expect(error.subjects).toEqual(['app/build/index.js -> googleapis']);
    assertNothingLeft(item);
  });

  it('requires acknowledgement for a dynamic import of a removed package', async () => {
    const source = "export const load = () => import('googleapis');\n";
    const unacknowledged = fixture({ buildFiles: { 'index.js': source } });
    const error = await failure(
      runBundle(await unacknowledged.plan(), unacknowledged.seams()),
    );
    expect(error.code).toBe('dynamic_import_unacknowledged');

    const acknowledged = fixture({
      buildFiles: { 'index.js': source },
      config: {
        acknowledgedDynamicImports: [
          { from: 'app/build/index.js', specifier: 'googleapis' },
        ],
      },
    });
    const { report } = await runBundle(
      await acknowledged.plan(),
      acknowledged.seams(),
    );
    expect(report.features.acknowledgedDynamicImports).toEqual([
      { from: 'app/build/index.js', specifier: 'googleapis' },
    ]);
  });

  it('keeps a feature group when it is enabled', async () => {
    const item = fixture({
      buildFiles: { 'index.js': "import 'googleapis';\n" },
    });
    const { report } = await runBundle(
      await item.plan({ features: ['google-apis'] }),
      item.seams(),
    );
    expect(report.features.enabled).toEqual(['google-apis']);
    expect(report.packages.map((p) => p.name)).toContain('googleapis');
  });

  it('drops source maps unless asked', async () => {
    const buildFiles = { 'index.js': 'export {};\n', 'index.js.map': '{}' };
    const dropped = fixture({ buildFiles });
    await runBundle(await dropped.plan(), dropped.seams());
    expect(
      existsSync(join(dropped.outDir, 'resources/app/build/index.js.map')),
    ).toBe(false);
    const kept = fixture({ buildFiles });
    await runBundle(await kept.plan({ keepSourceMaps: true }), kept.seams());
    expect(
      existsSync(join(kept.outDir, 'resources/app/build/index.js.map')),
    ).toBe(true);
  });
});

describe('natives', () => {
  it('rejects a native binary for another architecture', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js': 'export {};\n',
            'addon.node': machoThin({ cpu: 'x86_64', filetype: 8 }),
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('verification_failed');
    expect(error.stage).toBe('natives');
    expect(error.exitCode).toBe(5);
    expect(error.failures).toEqual([
      {
        path: 'resources/app/node_modules/a/addon.node',
        reason: 'wrong_machine',
      },
    ]);
    assertNothingLeft(item);
  });

  it('deletes a file matched by a native exception and records it', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js': 'export {};\n',
            'addon.node': machoThin({ cpu: 'x86_64', filetype: 8 }),
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
      config: {
        nativeExceptions: [
          { path: 'app/node_modules/a/addon.node', reason: 'optional addon' },
        ],
      },
    });
    const { report } = await runBundle(await item.plan(), item.seams());
    expect(
      existsSync(join(item.outDir, 'resources/app/node_modules/a/addon.node')),
    ).toBe(false);
    expect(report.nativeExceptions).toEqual([
      {
        path: 'resources/app/node_modules/a/addon.node',
        pattern: 'app/node_modules/a/addon.node',
        reason: 'optional addon',
      },
    ]);
  });
});

posixOnly('bridge', () => {
  it('rejects a bridge bundle that imports a bare package', async () => {
    const item = fixture({
      bridge: "import { z } from 'zod';\nimport 'node:fs';\n",
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('bridge_not_self_contained');
    expect(error.subjects).toEqual(['zod']);
    expect(error.stage).toBe('bridge');
    assertNothingLeft(item);
  });

  it('rejects a bridge that is a symlink', async () => {
    const item = fixture();
    const target = join(item.root, 'real-bridge.mjs');
    writeFileSync(target, "import 'node:fs';\n");
    const link = join(item.root, 'link-bridge.mjs');
    symlinkSync(target, link);
    const error = await failure(
      runBundle(await item.plan({ bridgeFile: link }), item.seams()),
    );
    expect(error.code).toBe('symlink_refused');
    assertNothingLeft(item);
  });

  it('records the bridge sha256 and byte count', async () => {
    const item = fixture();
    const { report } = await runBundle(await item.plan(), item.seams());
    const bytes = readFileSync(item.bridgeFile);
    expect(report.bridge).toEqual({
      file: 'bridge/smrt-mcp-bridge.mjs',
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  });
});

describe('size budget and measurement', () => {
  it('fails above the budget with the report attached and nothing published', async () => {
    const item = fixture({
      buildFiles: {
        'index.js': "import 'a';\n",
        'big.bin': Buffer.alloc(2 * 1024 * 1024, 1),
      },
    });
    const error = await failure(
      runBundle(await item.plan({ maxSizeMB: 1 }), item.seams()),
    );
    expect(error.code).toBe('size_budget_exceeded');
    expect(error.exitCode).toBe(6);
    expect(error.report?.files.bytes).toBeGreaterThan(1024 * 1024);
    assertNothingLeft(item);
  });

  it('measures the host bundle and appends the result to the report', async () => {
    const item = fixture();
    const measurements = {
      nodeVersionOutput: 'v26.8.1',
      healthRoute: '/api/_runtime/health',
      installed: { apparentBytes: 1, files: 1 },
      coldStart: {
        firstRun: { runs: 1, samplesMs: [10], medianMs: 10, maxMs: 10 },
        warm: { runs: 1, samplesMs: [5], medianMs: 5, maxMs: 5 },
      },
    };
    let input: { executablePath: string; resourcesDir: string } | undefined;
    const { report } = await runBundle(
      await item.plan({ measure: true }),
      item.seams({
        platform: 'darwin',
        arch: 'arm64',
        measure: async (request) => {
          input = request;
          return measurements;
        },
      }),
    );
    expect(report.measurements).toEqual(measurements);
    expect(
      input?.executablePath.endsWith('smrt-start-node-aarch64-apple-darwin'),
    ).toBe(true);
    const written = parseBundleReport(
      readFileSync(join(item.outDir, BUNDLE_REPORT_FILENAME), 'utf8'),
    );
    expect(written.measurements).toEqual(measurements);
  });

  it('refuses to measure a cross target', async () => {
    const item = fixture();
    const error = await failure(
      runBundle(
        await item.plan({ measure: true, target: 'x86_64-unknown-linux-gnu' }),
        item.seams({ platform: 'darwin', arch: 'arm64' }),
      ),
    );
    expect(error.code).toBe('measure_needs_host_target');
    expect(error.exitCode).toBe(2);
    assertNothingLeft(item);
  });

  it('fails when the measured start modifies the bundle', async () => {
    const item = fixture();
    const error = await failure(
      runBundle(
        await item.plan({ measure: true }),
        item.seams({
          platform: 'darwin',
          arch: 'arm64',
          measure: async (request) => {
            writeFileSync(join(request.resourcesDir, 'cache.tmp'), 'x');
            return {
              nodeVersionOutput: 'v26.8.1',
              healthRoute: '/h',
              installed: { apparentBytes: 1, files: 1 },
              coldStart: {
                firstRun: { runs: 1, samplesMs: [1], medianMs: 1, maxMs: 1 },
                warm: { runs: 1, samplesMs: [1], medianMs: 1, maxMs: 1 },
              },
            };
          },
        }),
      ),
    );
    expect(error.code).toBe('bundle_changed_while_measuring');
    expect(error.stage).toBe('measure');
    assertNothingLeft(item);
  });
});
