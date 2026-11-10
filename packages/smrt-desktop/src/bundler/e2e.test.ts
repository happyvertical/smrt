/**
 * Opt-in end-to-end test: bundles a tiny fixture app with the REAL pnpm, the
 * REAL nodejs.org download (checked against the committed pin) and the REAL
 * host start. It needs network access and pnpm, so it is skipped unless
 * `SMRT_DESKTOP_BUNDLE_E2E=1`:
 *
 *   SMRT_DESKTOP_BUNDLE_E2E=1 smrt test src/bundler/e2e.test.ts
 *
 * Never part of the default suite: the default suite is offline.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSidecarManifest } from '../sidecar-manifest.js';
import { buildChildEnv } from './child-env.js';
import { BundleError } from './errors.js';
import { createBundlePlan, hostTriple } from './options.js';
import { createPnpmRunner } from './pnpm-runner.js';
import { parseBundleReport } from './report.js';
import { runBundle } from './run.js';
import { createBundleSeams } from './runtime.js';

const enabled = process.env.SMRT_DESKTOP_BUNDLE_E2E === '1';
const host = hostTriple(process.platform, process.arch);
const suite = enabled && host !== undefined ? describe : describe.skip;

const SKIPPED_BECAUSE =
  'skipped by default: set SMRT_DESKTOP_BUNDLE_E2E=1 (needs network, pnpm and nodejs.org)';

if (!enabled) {
  describe('runtime bundler end to end', () => {
    it.skip(`bundles a fixture app with real pnpm, a real Node and a real start (${SKIPPED_BECAUSE})`, () => {});
  });
}

suite('runtime bundler end to end', () => {
  let root: string;
  let app: string;
  let out: string;
  let bridge: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundle-e2e-')));
    app = join(root, 'app');
    out = join(root, 'dist', 'bundle');
    bridge = join(root, 'bridge.mjs');
    const put = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    put(
      join(app, 'package.json'),
      `${JSON.stringify(
        {
          name: 'e2e-app',
          version: '1.0.0',
          type: 'module',
          private: true,
          dependencies: { ms: '2.1.3' },
        },
        null,
        2,
      )}\n`,
    );
    put(
      join(app, 'smrt-desktop.json'),
      `${JSON.stringify({
        version: 1,
        productId: 'e2e-app',
        bundleId: 'com.example.e2e-app',
        displayName: 'E2E App',
        bridge: { envPrefix: 'E2E_APP', mcpPath: '/mcp' },
      })}\n`,
    );
    // The smallest "adapter-node build": a server that answers the health route.
    put(
      join(app, 'build', 'index.js'),
      [
        "import { createServer } from 'node:http';",
        "import ms from 'ms';",
        'const server = createServer((req, res) => {',
        "  if (req.url === '/api/_runtime/health') {",
        "    res.setHeader('content-type', 'application/json');",
        "    res.end(JSON.stringify({ status: 'ready', app: process.env.SMRT_APP_ID, ms: ms('2h') }));",
        '    return;',
        '  }',
        '  res.statusCode = 404;',
        '  res.end();',
        '});',
        "server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1');",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
        '',
      ].join('\n'),
    );
    put(bridge, "import 'node:process';\n");
    mkdirSync(join(root, 'dist'), { recursive: true });

    // A real lockfile, resolved by the real pnpm.
    const pnpm = createPnpmRunner();
    const env = buildChildEnv(process.env, {});
    const locked = await pnpm.run({
      cwd: app,
      args: ['install', '--lockfile-only', '--ignore-scripts'],
      env,
    });
    expect(locked.exitCode, locked.output).toBe(0);
  }, 180_000);

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('bundles, verifies and measures a fixture app for the host triple', async () => {
    const plan = await createBundlePlan({
      appDir: app,
      outDir: out,
      bridgeFile: bridge,
      measure: true,
      maxSizeMB: 400,
    });
    const result = await runBundle(plan, createBundleSeams());

    const report = parseBundleReport(
      readFileSync(join(out, 'bundle-report.json'), 'utf8'),
    );
    expect(report).toEqual(result.report);
    expect(report.target).toBe(host);
    expect(report.packages.map((p) => p.name)).toEqual(['ms']);
    expect(report.natives.map((n) => n.path)).toEqual([
      `binaries/e2e-app-node-${host}${process.platform === 'win32' ? '.exe' : ''}`,
    ]);

    const sidecar = parseSidecarManifest(
      readFileSync(join(out, 'resources', 'sidecar-manifest.json'), 'utf8'),
    );
    expect(sidecar.executable).toBe('e2e-app-node');
    expect(
      existsSync(join(out, 'resources', 'app', 'node_modules', 'ms')),
    ).toBe(true);

    // The real start answered its health route twice per series.
    expect(report.measurements?.nodeVersionOutput).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(report.measurements?.coldStart.firstRun.runs).toBeGreaterThan(0);
    expect(report.measurements?.coldStart.warm.medianMs).toBeGreaterThan(0);
  }, 300_000);

  it('ignores pnpm configuration in an ancestor of --out', async () => {
    // The app, --out and the staging directory all sit below `hostile`, which
    // carries a workspace file that would claim them as projects, a pnpmfile
    // and config dependencies, a manifest that names another pnpm and a
    // .npmrc that points the registry at a dead port. None of it may apply.
    const hostile = realpathSync(
      mkdtempSync(join(tmpdir(), 'smrt-bundle-e2e-hostile-')),
    );
    try {
      const nested = join(hostile, 'app');
      mkdirSync(nested);
      for (const name of [
        'package.json',
        'pnpm-lock.yaml',
        'smrt-desktop.json',
      ]) {
        writeFileSync(join(nested, name), readFileSync(join(app, name)));
      }
      mkdirSync(join(nested, 'build'));
      writeFileSync(
        join(nested, 'build', 'index.js'),
        readFileSync(join(app, 'build', 'index.js')),
      );
      const marker = join(hostile, 'pnpmfile-ran');
      writeFileSync(
        join(hostile, 'evil-pnpmfile.cjs'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nmodule.exports = {};\n`,
      );
      writeFileSync(
        join(hostile, 'pnpm-workspace.yaml'),
        [
          "packages: ['**']",
          'pnpmfile: ./evil-pnpmfile.cjs',
          'overrides:',
          '  ms: 1.0.0',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(hostile, 'package.json'),
        JSON.stringify({
          name: 'hostile-root',
          packageManager: 'pnpm@9.0.0',
          pnpm: { overrides: { ms: '1.0.0' } },
        }),
      );
      writeFileSync(
        join(hostile, '.npmrc'),
        `registry=http://127.0.0.1:9/\nstore-dir=${join(hostile, 'hostile-store')}\n`,
      );
      mkdirSync(join(hostile, 'dist'));

      const plan = await createBundlePlan({
        appDir: nested,
        outDir: join(hostile, 'dist', 'bundle'),
        bridgeFile: bridge,
      });
      const result = await runBundle(plan, createBundleSeams());
      expect(
        result.report.packages.map((p) => `${p.name}@${p.version}`),
      ).toEqual(['ms@2.1.3']);
      expect(result.report.host.pnpm).not.toBe('9.0.0');
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(hostile, 'hostile-store'))).toBe(false);
      expect(existsSync(join(hostile, 'node_modules'))).toBe(false);
    } finally {
      rmSync(hostile, { recursive: true, force: true });
    }
  }, 300_000);

  it('fails when package.json drifts from the lockfile', async () => {
    const drifted = join(root, 'drifted');
    mkdirSync(drifted);
    for (const name of [
      'package.json',
      'pnpm-lock.yaml',
      'smrt-desktop.json',
    ]) {
      writeFileSync(join(drifted, name), readFileSync(join(app, name)));
    }
    mkdirSync(join(drifted, 'build'));
    writeFileSync(join(drifted, 'build', 'index.js'), 'export {};\n');
    const manifest = JSON.parse(
      readFileSync(join(drifted, 'package.json'), 'utf8'),
    );
    manifest.dependencies = { ms: '2.1.3', 'left-pad': '1.3.0' };
    writeFileSync(join(drifted, 'package.json'), JSON.stringify(manifest));

    const plan = await createBundlePlan({
      appDir: drifted,
      outDir: join(root, 'dist', 'drifted-out'),
      bridgeFile: bridge,
    });
    try {
      await runBundle(plan, createBundleSeams());
      throw new Error('expected the frozen install to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BundleError);
      expect((error as BundleError).code).toBe('lockfile_drift');
      expect((error as BundleError).exitCode).toBe(4);
    }
    expect(existsSync(join(root, 'dist', 'drifted-out'))).toBe(false);
  }, 180_000);
});
