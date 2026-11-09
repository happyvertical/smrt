import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as realBundler from '@happyvertical/smrt-desktop/bundler';
import { describe, expect, it, vi } from 'vitest';
import {
  type DesktopBundleCliOptions,
  type DesktopBundleIo,
  DesktopBundleUsageError,
  desktopCommands,
  parseDesktopBundleOptions,
  runDesktopBundle,
} from '../desktop.js';

const {
  BUNDLE_EXIT_CODES,
  BundleError,
  bundleExitCode,
  serializeBundleReport,
} = realBundler;

const report = {
  version: 1,
  tool: { name: '@happyvertical/smrt-desktop', version: '0.0.0' },
  product: {
    productId: 'smrt-start',
    bundleId: 'com.happyvertical.smrt-start',
    displayName: 'SMRT Start',
    productVersion: '1.2.3',
    channel: 'stable',
  },
  target: 'aarch64-apple-darwin',
  host: { platform: 'darwin', arch: 'arm64', node: '26.8.1', pnpm: '11.25.0' },
  inputs: {
    packageJsonSha256: '1'.repeat(64),
    lockfileSha256: '2'.repeat(64),
    buildTreeSha256: '3'.repeat(64),
  },
  node: {
    version: '26.8.1',
    distFile: 'node-v26.8.1-darwin-arm64.tar.gz',
    archiveSha256: '4'.repeat(64),
    binarySha256: '5'.repeat(64),
    machine: 'arm64',
    pin: {
      verification: 'unverified',
      source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
      retrieved: '2026-11-09T00:43:17Z',
      shasumsSha256: 'a'.repeat(64),
      signerFingerprints: [],
    },
  },
  bridge: {
    file: 'bridge/smrt-mcp-bridge.mjs',
    sha256: '6'.repeat(64),
    bytes: 9,
  },
  features: {
    enabled: [],
    removedPackages: [],
    acknowledgedDynamicImports: [],
  },
  importScan: {
    filesReached: 3,
    loadTimeFiles: 2,
    unresolvedBareImports: 0,
    nonLiteralImports: 0,
    unscannedFiles: 0,
  },
  packages: [],
  natives: [],
  nativeExceptions: [],
  pruned: {
    files: 1,
    bytes: 2,
    removedPackageFiles: 3,
    removedPackageBytes: 4,
  },
  files: {
    count: 3,
    bytes: 3 * 1024 * 1024,
    listSha256: '7'.repeat(64),
    tauriBundleSha256: '8'.repeat(64),
    breakdown: {
      nodeBinary: 1048576,
      nodeModules: 1048576,
      appBuild: 1048576,
      other: 0,
    },
  },
} as const;

interface Harness {
  io: DesktopBundleIo;
  stdout: string[];
  stderr: string[];
  plan: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function harness(run: () => unknown): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const plan = vi.fn(async (input: unknown) => ({ input }));
  const runFn = vi.fn(
    async (_plan: unknown, seams: { onStage?: (s: string) => void }) => {
      seams.onStage?.('inputs');
      seams.onStage?.('install');
      return run();
    },
  );
  const io: DesktopBundleIo = {
    loadBundler: async () =>
      ({
        ...realBundler,
        createBundlePlan: plan,
        createBundleSeams: (options: { onStage?: (s: string) => void }) =>
          options,
        runBundle: runFn,
      }) as unknown as typeof realBundler,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { io, stdout, stderr, plan, run: runFn };
}

const ok = () => ({
  report,
  outDir: '/out',
  warnings: ['installed size is large'],
  stages: [],
});

describe('desktop bundle option parsing', () => {
  it('maps every flag onto the bundler input', () => {
    const options: DesktopBundleCliOptions = {
      app: 'apps/start',
      build: 'apps/start/build',
      config: 'apps/start/smrt-desktop.json',
      target: 'x86_64-unknown-linux-gnu',
      out: 'dist/bundle',
      'product-id': 'smrt-start',
      'bundle-id': 'com.happyvertical.smrt-start',
      'display-name': 'SMRT Start',
      'product-version': '1.2.3',
      channel: 'beta',
      'node-version': '26.8.1',
      'node-archive': 'node.tar.gz',
      'node-cache': '/cache',
      bridge: 'bridge.mjs',
      features: 'images, ai-providers',
      'max-size': '350',
      measure: true,
      'measure-data': 'prepared',
      offline: true,
      'keep-sourcemaps': true,
      'require-verified-pins': true,
      force: true,
      json: true,
    };
    expect(parseDesktopBundleOptions([], options)).toEqual({
      json: true,
      input: {
        appDir: 'apps/start',
        buildDir: 'apps/start/build',
        productConfigPath: 'apps/start/smrt-desktop.json',
        target: 'x86_64-unknown-linux-gnu',
        outDir: 'dist/bundle',
        productId: 'smrt-start',
        bundleId: 'com.happyvertical.smrt-start',
        displayName: 'SMRT Start',
        productVersion: '1.2.3',
        channel: 'beta',
        nodeVersion: '26.8.1',
        nodeArchive: 'node.tar.gz',
        nodeCache: '/cache',
        bridgeFile: 'bridge.mjs',
        features: ['images', 'ai-providers'],
        maxSizeMB: 350,
        keepSourceMaps: true,
        offline: true,
        requireVerifiedPins: true,
        force: true,
        measure: true,
        measureDataDir: 'prepared',
      },
    });
  });

  it('defaults the app to the current directory and leaves the rest unset', () => {
    expect(parseDesktopBundleOptions([], { out: 'o' })).toEqual({
      json: false,
      input: { appDir: '.', outDir: 'o' },
    });
  });

  it.each<[string, DesktopBundleCliOptions, string[]]>([
    ['out', {}, []],
    ['out', { out: '' }, []],
    ['max-size', { out: 'o', 'max-size': '0' }, []],
    ['max-size', { out: 'o', 'max-size': 'big' }, []],
    ['max-size', { out: 'o', 'max-size': '1.5' }, []],
    ['features', { out: 'o', features: 'a,,b' }, []],
    ['target', { out: 'o', target: '' }, []],
    ['measure', { out: 'o', measure: 'yes' as never }, []],
    ['(arguments)', { out: 'o' }, ['stray']],
  ])('rejects a bad %s', (field, options, args) => {
    try {
      parseDesktopBundleOptions(args, options);
      throw new Error('expected a usage error');
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopBundleUsageError);
      expect((error as DesktopBundleUsageError).field).toBe(field);
    }
  });
});

describe('desktop bundle exit codes', () => {
  it('returns 0 and prints a summary on success', async () => {
    const h = harness(ok);
    expect(await runDesktopBundle([], { out: 'o' }, h.io)).toBe(0);
    const out = h.stdout.join('');
    expect(out).toContain('Bundle written to /out');
    expect(out).toContain('3.0 MiB in 3 files');
    expect(out).toContain('smrt-start@1.2.3 (aarch64-apple-darwin)');
    expect(h.stderr.join('')).toContain('[1/14] inputs');
    expect(h.stderr.join('')).toContain('warning: installed size is large');
    expect(h.plan).toHaveBeenCalledWith(
      expect.objectContaining({ outDir: 'o' }),
    );
  });

  it('prints only the canonical report on stdout with --json', async () => {
    const h = harness(ok);
    expect(await runDesktopBundle([], { out: 'o', json: true }, h.io)).toBe(0);
    expect(h.stdout.join('')).toBe(serializeBundleReport(report as never));
    expect(h.stderr.join('')).not.toContain('[1/');
  });

  const table: [string, () => unknown, number][] = [
    ['usage', () => new BundleError('measure_needs_host_target'), 2],
    ['invalid input', () => new BundleError('bridge_missing'), 3],
    ['provenance', () => new BundleError('lockfile_drift'), 4],
    ['verification', () => new BundleError('build_step_required'), 5],
    ['budget', () => new BundleError('size_budget_exceeded'), 6],
    ['child failed', () => new BundleError('pnpm_failed'), 7],
    ['io', () => new BundleError('io_failed', {}, 'tree'), 8],
    ['internal', () => new Error('boom /secret/path'), 1],
  ];

  it.each(
    table,
  )('maps a %s failure to its exit code', async (_name, make, code) => {
    const h = harness(() => {
      throw make();
    });
    expect(await runDesktopBundle([], { out: 'o' }, h.io)).toBe(code);
    expect(bundleExitCode(make())).toBe(code);
    expect(h.stderr.join('')).not.toContain('/secret/path');
    expect(h.stdout.join('')).toBe('');
  });

  it('keeps the table in step with the bundler', () => {
    expect(table.map(([, , code]) => code).sort()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(Object.values(BUNDLE_EXIT_CODES).sort()).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('reports a usage error without touching the bundler', async () => {
    const h = harness(ok);
    expect(await runDesktopBundle([], {}, h.io)).toBe(2);
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.stderr.join('')).toContain('[invalid_option, exit 2]');
    expect(h.stderr.join('')).toContain('option: out');
  });

  it('prints a failure document on stdout with --json and keeps stderr for humans', async () => {
    const h = harness(() => {
      throw new BundleError('lockfile_drift', { stage: 'install' });
    });
    expect(await runDesktopBundle([], { out: 'o', json: true }, h.io)).toBe(4);
    const document = JSON.parse(h.stdout.join(''));
    expect(document).toMatchObject({
      ok: false,
      code: 'lockfile_drift',
      category: 'provenance',
      exitCode: 4,
      stage: 'install',
    });
    expect(h.stderr.join('')).toContain('lockfile_drift');
  });

  it('lists offending subjects and native failures for a human', async () => {
    const h = harness(() => {
      throw new BundleError(
        'verification_failed',
        {
          stage: 'natives',
          failures: [{ path: 'resources/app/x.node', reason: 'wrong_machine' }],
          subjects: ['resources/app/x.node'],
        },
        'native',
      );
    });
    expect(await runDesktopBundle([], { out: 'o' }, h.io)).toBe(5);
    expect(h.stderr.join('')).toContain('resources/app/x.node: wrong_machine');
  });

  it('prints the report of an over-budget bundle that was not published', async () => {
    const h = harness(() => {
      throw new BundleError('size_budget_exceeded', {
        stage: 'report',
        report: report as never,
      });
    });
    expect(await runDesktopBundle([], { out: 'o' }, h.io)).toBe(6);
    expect(h.stderr.join('')).toContain(
      'installed size: 3.0 MiB (3 files); nothing was published',
    );

    const json = harness(() => {
      throw new BundleError('size_budget_exceeded', {
        report: report as never,
      });
    });
    expect(await runDesktopBundle([], { out: 'o', json: true }, json.io)).toBe(
      6,
    );
    expect(JSON.parse(json.stdout.join('')).report.files.bytes).toBe(
      3 * 1024 * 1024,
    );
  });

  it('reports a bundler that cannot be loaded as an internal error', async () => {
    const stderr: string[] = [];
    const code = await runDesktopBundle(
      [],
      { out: 'o' },
      {
        loadBundler: async () => {
          throw new Error('missing');
        },
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      },
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('could not be loaded');
  });
});

describe('desktop bundle command definition', () => {
  const command = desktopCommands['desktop bundle'];

  it('is registered under its two-word name with no positional arguments', () => {
    expect(Object.keys(desktopCommands)).toEqual(['desktop bundle']);
    expect(command?.name).toBe('desktop bundle');
    expect(command?.args).toEqual([]);
  });

  it('documents every flag in its help', () => {
    expect(Object.keys(command?.options ?? {}).sort()).toEqual(
      [
        'app',
        'build',
        'bridge',
        'bundle-id',
        'channel',
        'config',
        'display-name',
        'features',
        'force',
        'json',
        'keep-sourcemaps',
        'max-size',
        'measure',
        'measure-data',
        'node-archive',
        'node-cache',
        'node-version',
        'offline',
        'out',
        'product-id',
        'product-version',
        'require-verified-pins',
        'target',
      ].sort(),
    );
    for (const option of Object.values(command?.options ?? {})) {
      expect(option.description.length).toBeGreaterThan(10);
    }
    expect(command?.description).toContain('exit codes');
  });

  it('sets the process exit code from the handler', async () => {
    const previous = process.exitCode;
    try {
      await command?.handler?.([], { json: false } as never);
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe('desktop bundle is loaded lazily', () => {
  it('imports the bundler only dynamically', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../desktop.ts'),
      'utf8',
    );
    const staticImports = source
      .split('\n')
      .filter((line) => /^import\s/.test(line) && !/^import type\s/.test(line));
    expect(staticImports.join('\n')).not.toContain('smrt-desktop');
    expect(source).toContain("import('@happyvertical/smrt-desktop/bundler')");
  });
});
