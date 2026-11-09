import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSidecarManifest,
  serializeSidecarManifest,
} from '../sidecar-manifest.js';
import { BUNDLE_STAGES, BundleError } from './errors.js';
import { machoThin } from './native/testing/native-fixtures.js';
import { nodeTreeFs, type TreeFs } from './paths.js';
import {
  assertVerifiedNodePin,
  BUNDLE_FILES_FILENAME,
  BUNDLE_REPORT_FILENAME,
  parseBundleReport,
} from './report.js';
import { runBundle } from './run.js';
import { writeEarlierBundle } from './testing/report-fixture.js';
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
    expect(files).not.toContain('resources/smrt-bundle.json');
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
    const sidecar = parseSidecarManifest(sidecarText);
    expect(serializeSidecarManifest(sidecar)).toBe(sidecarText);
    expect(sidecar.executable).toBe('smrt-start-node');
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
      // The runtime would otherwise read package.json from the resource root.
      SMRT_APP_ID: 'smrt-start',
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
    writeEarlierBundle(item.outDir);
    const result = await runBundle(
      await item.plan({ force: true }),
      item.seams(),
    );
    expect(result.outDir).toBe(item.outDir);
    expect(existsSync(join(item.outDir, 'resources', 'old.txt'))).toBe(false);
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
      '--ignore-pnpmfile',
      '--os',
      'darwin',
      '--cpu',
      'arm64',
      '--config.pm-on-fail=ignore',
      '--config.node-linker=hoisted',
      '--config.side-effects-cache=false',
      '--config.package-import-method=copy',
      '--config.verify-store-integrity=true',
    ]);
    expect(call?.env.npm_config_ignore_scripts).toBe('true');
    // The app's own postinstall never reaches pnpm.
    expect(call?.manifest.scripts).toBeUndefined();
    expect(call?.manifest.name).toBe('fixture-app');
    expect(call?.manifest.dependencies).toEqual({
      a: '^1.0.0',
      googleapis: '^170.0.0',
    });
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

  it('fails a package whose only addon is for another platform (checked after pruning)', async () => {
    // The fixture target is darwin-arm64: `prebuilds/linux-x64` is dropped as
    // foreign, so nothing in the package survives for the target.
    const item = fixture({
      packages: [
        {
          name: 'a',
          scripts: { install: 'node-gyp-build' },
          files: {
            'index.js': 'export default 1;\n',
            'prebuilds/linux-x64/a.node': Buffer.from('not for this target'),
          },
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

  it('accepts a package whose prebuilds include the target next to foreign ones', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          scripts: { install: 'node-gyp-build' },
          files: {
            'index.js': 'export default 1;\n',
            'prebuilds/linux-x64/a.node': Buffer.from('foreign'),
            'prebuilds/win32-x64/a.node': Buffer.from('foreign'),
            'prebuilds/darwin-arm64/a.node': machoThin({
              cpu: 'arm64',
              filetype: 8,
            }),
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    await runBundle(await item.plan(), item.seams());
    const root = join(item.outDir, 'resources/app/node_modules/a/prebuilds');
    expect(readdirSync(root)).toEqual(['darwin-arm64']);
  });

  it('fails a package that builds only from a root binding.gyp', async () => {
    // No install script and no `gypfile`: npm would run node-gyp implicitly.
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js': 'export default 1;\n',
            'binding.gyp': '{ "targets": [] }\n',
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('build_step_required');
    expect(error.subjects).toEqual(['a']);
    assertNothingLeft(item);
  });

  it('accepts a binding.gyp package that ships a prebuilt addon for the target, and ignores one in a removed package', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js': 'export default 1;\n',
            'binding.gyp': '{ "targets": [] }\n',
            'build/Release/a.node': machoThin({ cpu: 'arm64', filetype: 8 }),
          },
        },
        {
          // Removed by segmentation (feature `google-apis`): never audited.
          name: 'googleapis',
          files: { 'index.js': '', 'binding.gyp': '{}\n' },
        },
      ],
    });
    await runBundle(await item.plan(), item.seams());
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

describe('Node pin provenance', () => {
  const verifiedPin = {
    verification: 'gpg-verified' as const,
    source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
    retrieved: '2026-12-01T00:00:00Z',
    shasumsSha256: 'c'.repeat(64),
    signerFingerprints: ['B'.repeat(40), 'A'.repeat(40)],
  };

  it('records the provenance of the pin it used and warns loudly while that pin is unverified', async () => {
    const item = fixture();
    const result = await runBundle(await item.plan(), item.seams());
    expect(result.report.node.pin).toEqual({
      verification: 'unverified',
      source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
      retrieved: '2026-11-09T00:43:17Z',
      shasumsSha256:
        '4f1c377505ddc3a872821cd333b72d9743673a41c939508d877e8cd8d4379336',
      signerFingerprints: [],
    });
    const warning = result.warnings.find((w) => w.startsWith('WARNING'));
    expect(warning).toContain('NOT verified');
    expect(warning).toContain('--require-verified-pins');
    expect(
      parseBundleReport(
        readFileSync(join(item.outDir, BUNDLE_REPORT_FILENAME), 'utf8'),
      ).node.pin.verification,
    ).toBe('unverified');
  });

  it('refuses the release and signing path while the pin is unverified, before any work', async () => {
    const item = fixture();
    const error = await failure(
      runBundle(await item.plan({ requireVerifiedPins: true }), item.seams()),
    );
    expect(error.code).toBe('node_pin_unverified');
    expect(error.category).toBe('provenance');
    expect(error.exitCode).toBe(4);
    expect(error.origin).toBe('node');
    expect(item.calls).toEqual([]);
    assertNothingLeft(item);
  });

  it('refuses a pin that claims gpg verification without its evidence', async () => {
    const item = fixture();
    const error = await failure(
      runBundle(await item.plan({ requireVerifiedPins: true }), {
        ...item.seams(),
        nodePinProvenance: () => ({ ...verifiedPin, signerFingerprints: [] }),
      }),
    );
    expect(error.code).toBe('node_pin_unverified');
    assertNothingLeft(item);
  });

  it('bundles on the release path with a verified pin and records signers and digest, sorted, with no warning', async () => {
    const item = fixture();
    const result = await runBundle(
      await item.plan({ requireVerifiedPins: true }),
      { ...item.seams(), nodePinProvenance: () => verifiedPin },
    );
    expect(result.report.node.pin).toEqual({
      ...verifiedPin,
      signerFingerprints: ['A'.repeat(40), 'B'.repeat(40)],
    });
    expect(result.warnings.some((w) => w.startsWith('WARNING'))).toBe(false);
    assertVerifiedNodePin(
      parseBundleReport(
        readFileSync(join(item.outDir, BUNDLE_REPORT_FILENAME), 'utf8'),
      ),
    );
  });

  it('still refuses an unpinned version with the usage error', async () => {
    const item = fixture();
    const error = await failure(
      runBundle(await item.plan({ nodeVersion: '26.0.0' }), item.seams()),
    );
    expect(error.code).toBe('unpinned_version');
    expect(error.exitCode).toBe(2);
    expect(item.calls).toEqual([]);
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

  it('fails on a .smrt data directory inside the build', async () => {
    const item = fixture({
      buildFiles: { 'index.js': 'export {};\n', '.smrt/data.json': '{}' },
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('secret_file');
    expect(error.subjects).toEqual(['.smrt']);
    assertNothingLeft(item);
  });

  it('never copies the app .npmrc into the output', async () => {
    const item = fixture({
      npmrc:
        'registry=https://registry.example/\n//registry.example/:_authToken=abc123\n',
    });
    await runBundle(await item.plan(), item.seams());
    expect(item.calls[0]?.hadNpmrc).toBe(true);
    const files = [...readTree(item.outDir).keys()];
    expect(files.some((f) => f.endsWith('.npmrc'))).toBe(false);
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
      npmrc: `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${canary}-npmrc\n`,
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

    // Its registry line reached the install directory, its credentials did
    // not ...
    expect(item.calls[0]?.hadNpmrc).toBe(true);
    expect(item.calls[0]?.npmrc).toBe('registry=https://registry.npmjs.org/\n');
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

  it('keeps a file a reached module imports from a directory that pruning removes by name', async () => {
    // `test/` at a package root is pruned; a relative import makes it code.
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js': "import './test/setup.js';\nexport default 1;\n",
            'test/setup.js': 'export default 2;\n',
            'test/unused.js': 'export default 3;\n',
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    await runBundle(await item.plan(), item.seams());
    const base = join(item.outDir, 'resources/app/node_modules/a');
    expect(existsSync(join(base, 'test/setup.js'))).toBe(true);
    // The directory is kept because a file in it is needed, and with it its
    // other files (JavaScript is never pruned by name).
    expect(readdirSync(join(base, 'test')).sort()).toEqual([
      'setup.js',
      'unused.js',
    ]);
  });

  it('keeps data files a reached module reads by a literal path, and still prunes docs nobody names', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js':
              "import { readFileSync } from 'node:fs';\nexport default readFileSync(new URL('./docs/guide.md', import.meta.url));\n",
            'docs/guide.md': '# needed at run time\n',
            'docs/other.md': '# not needed\n',
            'README.md': '# readme\n',
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    await runBundle(await item.plan(), item.seams());
    const base = join(item.outDir, 'resources/app/node_modules/a');
    expect(existsSync(join(base, 'docs/guide.md'))).toBe(true);
    expect(existsSync(join(base, 'docs/other.md'))).toBe(false);
    expect(existsSync(join(base, 'README.md'))).toBe(false);
  });

  it('does not let a reference to a package root keep its tests, docs and fixtures, so a fixture key is pruned instead of failing the bundle', async () => {
    const pem = `-----BEGIN ${'RSA'} PRIVATE KEY-----\nMIIB\n`;
    for (const reference of [
      "const root = path.resolve(__dirname, '..');",
      "const root = join(__dirname, '..');",
      "const root = new URL('./', import.meta.url);",
      "const root = new URL('../', import.meta.url);",
      "const names = readdirSync('../');",
    ]) {
      const item = fixture({
        packages: [
          {
            name: 'a',
            files: {
              'index.js': "import './lib/x.js';\nexport default 1;\n",
              'lib/x.js': `${reference}\nexport default root;\n`,
              'test/fixtures/key.pem': pem,
              'test/fixtures/.env.test': 'TOKEN=abc\n',
              'docs/guide.md': '# docs\n',
              'types/shape.d.ts': 'export {};\n',
            },
          },
          { name: 'googleapis', files: { 'index.js': '' } },
        ],
      });
      await runBundle(await item.plan(), item.seams());
      const base = join(item.outDir, 'resources/app/node_modules/a');
      expect(existsSync(join(base, 'lib/x.js')), reference).toBe(true);
      expect(existsSync(join(base, 'test')), reference).toBe(false);
      expect(existsSync(join(base, 'docs')), reference).toBe(false);
      expect(existsSync(join(base, 'types/shape.d.ts')), reference).toBe(false);
    }
  });

  it('keeps everything under an explicit asset directory a reached module names', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js':
              "import { readdirSync } from 'node:fs';\nexport default readdirSync(new URL('./assets/', import.meta.url));\n",
            'assets/deep/readme.md': '# needed at run time\n',
            'assets/schema.d.ts': 'export {};\n',
            'docs/other.md': '# not needed\n',
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    await runBundle(await item.plan(), item.seams());
    const base = join(item.outDir, 'resources/app/node_modules/a');
    expect(existsSync(join(base, 'assets/deep/readme.md'))).toBe(true);
    expect(existsSync(join(base, 'assets/schema.d.ts'))).toBe(true);
    expect(existsSync(join(base, 'docs/other.md'))).toBe(false);
  });

  it('fails when a reached file imports a relative path that is not in the bundle', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: { 'index.js': "import './never-shipped.js';\n" },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('relative_import_missing');
    expect(error.stage).toBe('scan');
    expect(error.exitCode).toBe(5);
    expect(error.subjects).toEqual([
      'node_modules/a/index.js -> ./never-shipped.js',
    ]);
    assertNothingLeft(item);
  });

  it('fails on a missing relative import in the application build, and lets a lazy one be acknowledged', async () => {
    const lazy = "export const load = () => import('./optional.js');\n";
    const unacknowledged = fixture({ buildFiles: { 'index.js': lazy } });
    const error = await failure(
      runBundle(await unacknowledged.plan(), unacknowledged.seams()),
    );
    expect(error.code).toBe('relative_import_missing');
    expect(error.subjects).toEqual(['app/build/index.js -> ./optional.js']);

    const acknowledged = fixture({
      buildFiles: { 'index.js': lazy },
      config: {
        acknowledgedDynamicImports: [
          { from: 'app/build/index.js', specifier: './optional.js' },
        ],
      },
    });
    const { report } = await runBundle(
      await acknowledged.plan(),
      acknowledged.seams(),
    );
    expect(report.features.acknowledgedDynamicImports).toEqual([
      { from: 'app/build/index.js', specifier: './optional.js' },
    ]);
  });

  it('records what the import scan covered, including bare imports that resolved to nothing', async () => {
    const item = fixture({
      packages: [
        {
          name: 'a',
          files: {
            'index.js':
              "import 'not-installed';\nimport './lib.js';\nconst n = 'x'; import(n);\n",
            'lib.js': 'export {};\n',
          },
        },
        { name: 'googleapis', files: { 'index.js': '' } },
      ],
    });
    const result = await runBundle(await item.plan(), item.seams());
    expect(result.report.importScan).toEqual({
      filesReached: 3,
      loadTimeFiles: 3,
      unresolvedBareImports: 1,
      nonLiteralImports: 1,
      unscannedFiles: 0,
    });
    expect(
      result.warnings.some((w) =>
        w.includes('bare import(s) resolve to nothing'),
      ),
    ).toBe(true);
    expect(
      parseBundleReport(
        readFileSync(join(item.outDir, BUNDLE_REPORT_FILENAME), 'utf8'),
      ).importScan,
    ).toEqual(result.report.importScan);
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

  it('accepts bare built-in module names as well as node: specifiers', async () => {
    const item = fixture({
      bridge:
        "import fs from 'fs';\nimport { join } from 'path/posix';\nimport 'node:os';\nexport { fs, join };\n",
    });
    await runBundle(await item.plan(), item.seams());
    expect(
      existsSync(join(item.outDir, 'resources/bridge/smrt-mcp-bridge.mjs')),
    ).toBe(true);
  });

  it('rejects relative and scoped imports in the bridge too', async () => {
    const item = fixture({
      bridge: "import './local.js';\nimport '@scope/pkg';\n",
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('bridge_not_self_contained');
    expect(error.subjects).toEqual(['(relative import)', '@scope/pkg']);
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

  it('hands the prepared data directory to the measurement', async () => {
    const item = fixture();
    const template = join(item.root, 'prepared-data');
    mkdirSync(template);
    let seen: string | undefined;
    await runBundle(
      await item.plan({ measure: true, measureDataDir: template }),
      item.seams({
        platform: 'darwin',
        arch: 'arm64',
        measure: async (request) => {
          seen = request.dataTemplate;
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
    );
    expect(seen).toBe(template);
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

describe('pnpm configuration the app brings', () => {
  it.each([
    ['configDependencies', 'configDependencies:\n  hooks: 1.0.0+sha512-abc\n'],
    ['pnpmfile', 'pnpmfile: ./hooks.cjs\n'],
    ['globalPnpmfile', 'globalPnpmfile: ./global.cjs\n'],
    ['storeDir', 'storeDir: /tmp/CANARY-outside\n'],
    ['virtualStoreDir', 'virtualStoreDir: ../../escape\n'],
    ['strictSsl', 'strictSsl: false\n'],
  ])('fails before any install when pnpm-workspace.yaml sets %s', async (name, yaml) => {
    const item = fixture({ workspaceYaml: yaml });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('unsafe_install_config');
    expect(error.exitCode).toBe(3);
    expect(error.stage).toBe('inputs');
    expect(error.subjects).toEqual([name]);
    expect(JSON.stringify(error)).not.toContain('CANARY-outside');
    expect(item.calls).toHaveLength(0);
    assertNothingLeft(item);
  });

  it('fails before any install on a non-registry override and lists no values', async () => {
    const item = fixture({
      workspaceYaml: 'overrides:\n  a: link:/CANARY-secret/dir\n',
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('unsafe_install_config');
    expect(error.subjects).toEqual(['overrides (non-registry specifier)']);
    expect(JSON.stringify(error)).not.toContain('CANARY-secret');
    expect(item.calls).toHaveLength(0);
  });

  it.each([
    'pnpmfile=./hooks.cjs',
    'global-pnpmfile=/somewhere/global.cjs',
  ])('fails before any install when .npmrc sets %s', async (line) => {
    const item = fixture({ npmrc: `registry=https://r.example/\n${line}\n` });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('unsafe_install_config');
    expect(error.exitCode).toBe(3);
    expect(error.stage).toBe('inputs');
    expect(JSON.stringify(error)).not.toContain('hooks.cjs');
    expect(item.calls).toHaveLength(0);
    assertNothingLeft(item);
  });

  it('fails when the package.json pnpm field sets a pnpmfile', async () => {
    const item = fixture({
      appManifest: { pnpm: { pnpmfile: './hooks.cjs' } },
    });
    const error = await failure(runBundle(await item.plan(), item.seams()));
    expect(error.code).toBe('unsafe_install_config');
    expect(item.calls).toHaveLength(0);
  });

  it('stages only registry and boolean lines of .npmrc and records their hash', async () => {
    const canary = 'CANARY-5d2e9a7b13c4';
    const item = fixture({
      npmrc: [
        'registry=https://registry.example.com/',
        '@acme:registry=https://npm.acme.test/',
        `//registry.example.com/:_authToken=${canary}`,
        'script-shell=/tmp/evil.sh',
        'auto-install-peers=false',
        '',
      ].join('\n'),
    });
    const result = await runBundle(await item.plan(), item.seams());
    const staged = item.calls[0]?.npmrc as string;
    expect(staged).toBe(
      [
        'registry=https://registry.example.com/',
        '@acme:registry=https://npm.acme.test/',
        'auto-install-peers=false',
        '',
      ].join('\n'),
    );
    expect(result.report.inputs.npmrcSha256).toBe(sha256(staged));
    expect(result.warnings.join('\n')).toContain(
      '2 .npmrc line(s) were not used',
    );
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('stages no .npmrc and records no hash when nothing in it is usable', async () => {
    const item = fixture({ npmrc: '//registry.example.com/:_authToken=abc\n' });
    const result = await runBundle(await item.plan(), item.seams());
    expect(item.calls[0]?.hadNpmrc).toBe(false);
    expect(result.report.inputs.npmrcSha256).toBeUndefined();
  });

  it('drops a registry line that expands an environment variable', async () => {
    const item = fixture({
      npmrc: `registry=https://$\x7bREGISTRY_HOST}/npm/\nauto-install-peers=false\n`,
    });
    await runBundle(await item.plan(), item.seams());
    expect(item.calls[0]?.npmrc).toBe('auto-install-peers=false\n');
  });

  it('writes a minimal workspace file when the app has none, and records no hash for it', async () => {
    const item = fixture();
    const result = await runBundle(await item.plan(), item.seams());
    expect(item.calls[0]?.workspace).toBe('packages: []\n');
    expect(result.report.inputs.workspaceYamlSha256).toBeUndefined();
  });

  it('passes an ordinary workspace file through unchanged and records its hash', async () => {
    const yaml = 'overrides:\n  lodash: 4.17.21\n# pnpmfile: not used\n';
    const item = fixture({ workspaceYaml: yaml });
    const result = await runBundle(await item.plan(), item.seams());
    expect(item.calls[0]?.workspace).toBe(yaml);
    expect(result.report.inputs.workspaceYamlSha256).toBe(sha256(yaml));
  });
});

/** Where pnpm would find a workspace file: the directory or the nearest parent with one. */
function nearestWorkspaceDir(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

describe('configuration in an ancestor of --out', () => {
  const HOSTILE_WORKSPACE = [
    "packages: ['**']",
    'pnpmfile: ./CANARY-evil-pnpmfile.cjs',
    'configDependencies:',
    '  evil: 1.0.0+sha512-CANARY',
    'overrides:',
    '  a: link:../CANARY-elsewhere',
    '',
  ].join('\n');

  function hostileAncestor(item: Fixture): void {
    // `root` holds the app and `dist`; `dist` holds --out and the staging
    // directory, so all three are below it.
    writeFileSync(join(item.root, 'pnpm-workspace.yaml'), HOSTILE_WORKSPACE);
    writeFileSync(
      join(item.root, 'package.json'),
      JSON.stringify({
        name: 'hostile-root',
        packageManager: 'pnpm@9.0.0',
        pnpm: { overrides: { a: '0.0.1' }, pnpmfile: 'CANARY.cjs' },
      }),
    );
    writeFileSync(
      join(item.root, '.npmrc'),
      'registry=http://127.0.0.1:9/\nstore-dir=/tmp/CANARY-store\n',
    );
  }

  function recording(item: Fixture) {
    const base = item.seams();
    const installFrom: Array<string | undefined> = [];
    const probeFrom: Array<string | undefined> = [];
    const installCwd: string[] = [];
    const probeCwd: string[] = [];
    return {
      installFrom,
      probeFrom,
      installCwd,
      probeCwd,
      seams: item.seams({
        runPnpm: async (request) => {
          installFrom.push(nearestWorkspaceDir(request.cwd));
          installCwd.push(request.cwd);
          return base.runPnpm(request);
        },
        pnpmVersion: async (_env, cwd) => {
          probeFrom.push(nearestWorkspaceDir(cwd));
          probeCwd.push(cwd);
          return '11.25.0';
        },
      }),
    };
  }

  it('gives the install and the version probe their own workspace file when the app has none', async () => {
    const item = fixture();
    hostileAncestor(item);
    const seen = recording(item);
    await runBundle(await item.plan(), seen.seams);
    expect(seen.installFrom).toHaveLength(1);
    expect(seen.probeFrom).toHaveLength(1);
    // The nearest workspace file is in the directory pnpm runs in, so the
    // ancestor's is never reached.
    expect(seen.installFrom[0]).toBe(seen.installCwd[0]);
    expect(seen.probeFrom[0]).toBe(seen.probeCwd[0]);
    expect(seen.installFrom[0]).not.toBe(item.root);
    expect(item.calls[0]?.workspace).toBe('packages: []\n');
  });

  it('keeps the app workspace file, not the ancestor one, and records only the app hash', async () => {
    const yaml = 'overrides:\n  a: 1.0.0\n';
    const item = fixture({ workspaceYaml: yaml });
    hostileAncestor(item);
    const seen = recording(item);
    const result = await runBundle(await item.plan(), seen.seams);
    expect(seen.installFrom[0]).toBe(seen.installCwd[0]);
    expect(item.calls[0]?.workspace).toBe(yaml);
    expect(result.report.inputs.workspaceYamlSha256).toBe(sha256(yaml));
  });

  it('puts nothing of the ancestor files in the install argv, staged files or output', async () => {
    const plain = fixture();
    await runBundle(await plain.plan(), plain.seams());
    const item = fixture();
    hostileAncestor(item);
    const result = await runBundle(await item.plan(), item.seams());
    const call = item.calls[0];
    expect(call?.args).toEqual(plain.calls[0]?.args);
    expect(call?.hadNpmrc).toBe(false);
    expect(call?.workspace).not.toContain('CANARY');
    const everything =
      JSON.stringify(result) +
      [...readTree(item.outDir).values()]
        .map((b) => b.toString('latin1'))
        .join('');
    expect(everything).not.toContain('CANARY');
  });
});

describe('the pnpm version', () => {
  it('stages a manifest without packageManager or devEngines', async () => {
    const item = fixture({
      appManifest: {
        packageManager: 'pnpm@9.0.0',
        devEngines: { packageManager: { name: 'pnpm', version: '9.0.0' } },
      },
    });
    await runBundle(await item.plan(), item.seams());
    expect(item.calls[0]?.manifest.packageManager).toBeUndefined();
    expect(item.calls[0]?.manifest.devEngines).toBeUndefined();
    expect(item.calls[0]?.manifest.name).toBe('fixture-app');
  });

  it('probes the version from a bare directory outside the install directory', async () => {
    const item = fixture();
    let listing: string[] | undefined;
    let probed: string | undefined;
    await runBundle(
      await item.plan(),
      item.seams({
        pnpmVersion: async (_env, cwd) => {
          probed = cwd;
          listing = readdirSync(cwd);
          return '11.25.0';
        },
      }),
    );
    // Only the files that stop pnpm's upward search for a workspace file and
    // a manifest.
    expect(listing?.sort()).toEqual(['package.json', 'pnpm-workspace.yaml']);
    expect(probed).not.toBe(item.calls[0]?.cwd);
    expect(probed?.startsWith(item.appDir)).toBe(false);
  });

  it('warns when the host pnpm differs from the app packageManager and reports the host pnpm', async () => {
    const item = fixture({ appManifest: { packageManager: 'pnpm@9.0.0' } });
    const result = await runBundle(
      await item.plan(),
      item.seams({ pnpmVersion: async () => '11.25.0' }),
    );
    expect(result.report.host.pnpm).toBe('11.25.0');
    expect(result.warnings.join('\n')).toContain(
      "pnpm 11.25.0 differs from the app's packageManager (pnpm@9.0.0)",
    );
  });
});

describe('files written around the measured start', () => {
  const measurements = {
    nodeVersionOutput: 'v26.8.1',
    healthRoute: '/h',
    installed: { apparentBytes: 1, files: 1 },
    coldStart: {
      firstRun: { runs: 1, samplesMs: [1], medianMs: 1, maxMs: 1 },
      warm: { runs: 1, samplesMs: [1], medianMs: 1, maxMs: 1 },
    },
  };
  it('writes tauri.bundle.json and the file list only after the measured start', async () => {
    const item = fixture();
    let rootAtMeasure: string[] | undefined;
    const result = await runBundle(
      await item.plan({ measure: true }),
      item.seams({
        platform: 'darwin',
        arch: 'arm64',
        measure: async (request) => {
          rootAtMeasure = readdirSync(request.bundleRoot).sort();
          return measurements;
        },
      }),
    );
    expect(rootAtMeasure).toEqual(['binaries', 'resources']);
    const tauri = readFileSync(join(item.outDir, 'tauri.bundle.json'));
    expect(result.report.files.tauriBundleSha256).toBe(sha256(tauri));
    const list = readFileSync(join(item.outDir, BUNDLE_FILES_FILENAME));
    expect(result.report.files.listSha256).toBe(sha256(list));
  });

  it('fails when the measured start plants or changes a file in the bundle root', async () => {
    for (const name of [
      'tauri.bundle.json',
      BUNDLE_FILES_FILENAME,
      BUNDLE_REPORT_FILENAME,
      'extra.txt',
    ]) {
      const item = fixture();
      const error = await failure(
        runBundle(
          await item.plan({ measure: true }),
          item.seams({
            platform: 'darwin',
            arch: 'arm64',
            measure: async (request) => {
              writeFileSync(join(request.bundleRoot, name), 'planted');
              return measurements;
            },
          }),
        ),
      );
      expect(error.code, name).toBe('bundle_changed_while_measuring');
      expect(error.stage, name).toBe('measure');
      assertNothingLeft(item);
    }
  });
});
