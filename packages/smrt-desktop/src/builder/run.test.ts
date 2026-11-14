import { describe, expect, it } from 'vitest';
import { TAURI_CLI_VERSION } from './constants.js';
import { BuildError } from './errors.js';
import {
  buildToolchainEnv,
  cargoLockWrapperVersion,
  cargoPackageVersion,
  createBuildPlan,
  runBuild,
} from './run.js';
import { APP, BUNDLE, createFixture, OUT, TARGET } from './testing/fixtures.js';

const host = { platform: 'darwin' as const, arch: 'arm64', cwd: '/' };
const plan = (extra: Record<string, unknown> = {}) =>
  createBuildPlan(
    { appDir: APP, bundleDir: BUNDLE, outDir: OUT, ...extra },
    host,
  );

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return (error as BuildError).code;
  }
  throw new Error('expected a BuildError');
}

describe('createBuildPlan', () => {
  it('resolves relative paths against the invocation directory', () => {
    const relative = createBuildPlan(
      { appDir: '.', bundleDir: 'b/bundle', outDir: '../out' },
      { ...host, cwd: '/work/app' },
    );
    expect(relative).toMatchObject({
      appDir: '/work/app',
      bundleDir: '/work/app/b/bundle',
      outDir: '/work/out',
    });
  });
  it('defaults to the host target and rejects unsupported ones', () => {
    expect(plan().target).toBe(TARGET);
    expect(() => plan({ target: 'riscv64-unknown-linux-gnu' })).toThrow(
      BuildError,
    );
  });
  it('needs every path option', () => {
    expect(() =>
      createBuildPlan({ appDir: '', bundleDir: BUNDLE, outDir: OUT }, host),
    ).toThrow(BuildError);
  });
  it('refuses the smoke for a target that is not the host', () => {
    expect(() =>
      plan({ smoke: true, target: 'x86_64-unknown-linux-gnu' }),
    ).toThrow(expect.objectContaining({ code: 'smoke_needs_host_target' }));
  });
});

describe('the Cargo version readers', () => {
  it('read the package table only', () => {
    const toml =
      '[workspace]\nversion = "9.9.9"\n[package]\nname = "x"\nversion = "1.0.0" # c\n[dependencies]\nversion = "2"\n';
    expect(cargoPackageVersion(toml)).toBe('1.0.0');
    expect(
      cargoLockWrapperVersion(
        '[[package]]\nname = "smrt-desktop-wrapper"\nversion = "3.4.5"\n',
      ),
    ).toBe('3.4.5');
  });
});

describe('runBuild', () => {
  it('builds an unsigned installer through the pinned stages', async () => {
    const fixture = createFixture();
    const result = await runBuild(plan(), fixture.seams);
    expect(result.signed).toBe(false);
    expect(result.installers).toEqual(['Demo App.app']);
    expect(fixture.stages).toEqual([
      'inputs',
      'materialize',
      'stage_bundle',
      'configure',
      'tauri_build',
      'collect',
    ]);
    const tauri = fixture.calls.find((c) => c.args[0] === 'build');
    expect(tauri?.args).toEqual([
      'build',
      '--no-sign',
      '--target',
      TARGET,
      '--config',
      'tauri.build.json',
      '--bundles',
      'app',
      '--',
      '--locked',
    ]);
    expect(
      fixture.fs.files.has(`${OUT}/Demo App.app/Contents/MacOS/demo`),
    ).toBe(true);
    // The scratch tree is gone and nothing was written beside the output.
    expect(
      [...fixture.fs.files.keys()].some((p) =>
        p.includes('.smrt-desktop-build-'),
      ),
    ).toBe(false);
  });

  it('writes the overlay from the product identity, icons and updater key only', async () => {
    const fixture = createFixture();
    let overlay = '';
    const original = fixture.seams.run;
    const seams = {
      ...fixture.seams,
      async run(request: Parameters<typeof original>[0]) {
        const path = `${request.cwd}/tauri.build.json`;
        if (request.command === 'tauri') {
          overlay = new TextDecoder().decode(fixture.fs.files.get(path));
        }
        return original(request);
      },
    };
    await runBuild(plan(), seams);
    expect(JSON.parse(overlay)).toEqual({
      productName: 'Demo App',
      identifier: 'com.example.demo',
      version: '1.2.3',
      bundle: {
        icon: ['icons/product/icon.png', 'icons/product/icon.ico'],
        externalBin: ['binaries/demo-node'],
        resources: { 'resources/': './' },
      },
      plugins: { updater: { pubkey: 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=' } },
    });
  });

  it('never forwards signing variables or tokens to a child', async () => {
    const fixture = createFixture();
    await runBuild(plan(), fixture.seams);
    expect(fixture.calls.length).toBeGreaterThan(0);
    for (const call of fixture.calls) {
      expect(Object.keys(call.env)).not.toEqual(
        expect.arrayContaining(['APPLE_PASSWORD']),
      );
      expect(JSON.stringify(call.env)).not.toContain('never-forwarded');
    }
    expect(
      buildToolchainEnv({
        DISPLAY: ':99',
        XAUTHORITY: '/tmp/xvfb-run.1/Xauthority',
        NPM_TOKEN: 'x',
      }),
    ).toEqual({
      DISPLAY: ':99',
      XAUTHORITY: '/tmp/xvfb-run.1/Xauthority',
      CARGO_TERM_COLOR: 'never',
      CARGO_INCREMENTAL: '0',
    });
    expect(buildToolchainEnv({ NPM_TOKEN: 'x', PATH: '/a' })).toEqual({
      PATH: '/a',
      CARGO_TERM_COLOR: 'never',
      CARGO_INCREMENTAL: '0',
    });
  });

  it('fails closed when an owner input is missing (no default icons)', async () => {
    const fixture = createFixture({ config: { icons: undefined } });
    expect(await code(runBuild(plan(), fixture.seams))).toBe(
      'identity_missing',
    );
    expect(fixture.calls.filter((c) => c.args[0] === 'build')).toEqual([]);
  });

  it('warns, not fails, without an updater public key (unsigned builds)', async () => {
    const fixture = createFixture({ config: { updaterPublicKey: undefined } });
    const result = await runBuild(plan(), fixture.seams);
    expect(result.warnings).toHaveLength(1);
  });

  it('fails on version drift between the wrapper and the package', async () => {
    const fixture = createFixture({ cargoVersion: '0.1.0' });
    expect(await code(runBuild(plan(), fixture.seams))).toBe(
      'wrapper_version_drift',
    );
    expect(fixture.calls.filter((c) => c.args[0] === 'build')).toEqual([]);
  });

  it('refuses another Tauri CLI version', async () => {
    const fixture = createFixture();
    fixture.tauriVersion = 'tauri-cli 2.0.0';
    expect(await code(runBuild(plan(), fixture.seams))).toBe(
      'tauri_version_mismatch',
    );
    fixture.tauriVersion = `tauri-cli ${TAURI_CLI_VERSION}`;
    await expect(runBuild(plan(), fixture.seams)).resolves.toBeDefined();
  });

  it('refuses a bundle for another target, product or a changed file', async () => {
    expect(
      await code(
        runBuild(
          plan(),
          createFixture({ reportTarget: 'x86_64-apple-darwin' }).seams,
        ),
      ),
    ).toBe('bundle_mismatch');

    const changed = createFixture();
    changed.fs.files.set(
      `${BUNDLE}/resources/sidecar-manifest.json`,
      new TextEncoder().encode('{"tampered":1}'),
    );
    expect(await code(runBuild(plan(), changed.seams))).toBe('bundle_mismatch');

    const extra = createFixture();
    extra.fs.put(`${BUNDLE}/resources/extra.txt`, 'unlisted');
    expect(await code(runBuild(plan(), extra.seams))).toBe('bundle_mismatch');

    const other = createFixture();
    other.fs.others.add(`${BUNDLE}/resources/link`);
    other.fs.dirs.add(`${BUNDLE}/resources`);
    expect(await code(runBuild(plan(), other.seams))).toBe('bundle_mismatch');
  });

  it('refuses a fragment that is not exactly what the bundler writes', async () => {
    const fixture = createFixture();
    fixture.fs.files.set(
      `${BUNDLE}/tauri.bundle.json`,
      new TextEncoder().encode(
        JSON.stringify({
          bundle: {
            externalBin: ['binaries/demo-node'],
            resources: { 'resources/': './' },
            active: false,
          },
        }),
      ),
    );
    expect(await code(runBuild(plan(), fixture.seams))).toBe('bundle_invalid');
  });

  it('maps a failing tauri to a fixed error without child output', async () => {
    const fixture = createFixture();
    fixture.exit.tauri = 1;
    const error = await runBuild(plan(), fixture.seams).catch(
      (e) => e as BuildError,
    );
    expect(error).toMatchObject({
      code: 'tauri_failed',
      exitCode: 7,
      stage: 'tauri_build',
    });
    expect(error.message).toBe('tauri build failed');
    expect([...fixture.fs.files.keys()].some((p) => p.startsWith(OUT))).toBe(
      false,
    );
  });

  it('fails when tauri produced no installer', async () => {
    const fixture = createFixture();
    fixture.produce = false;
    expect(await code(runBuild(plan(), fixture.seams))).toBe('no_installer');
  });

  it('refuses a non-empty output directory', async () => {
    const fixture = createFixture();
    fixture.fs.put(`${OUT}/old.txt`, 'x');
    expect(await code(runBuild(plan(), fixture.seams))).toBe('output_exists');
  });

  it('runs the launch smoke after tauri and before collecting, for the host target only', async () => {
    const fixture = createFixture();
    await runBuild(plan({ smoke: true }), fixture.seams);
    expect(fixture.stages.slice(-3)).toEqual([
      'tauri_build',
      'smoke',
      'collect',
    ]);
    const smoke = fixture.calls.at(-1);
    expect(smoke?.command).toBe('/usr/bin/node');
    expect(smoke?.args.slice(0, 1)).toEqual(['scripts/launch-smoke.mjs']);
    expect(smoke?.args).toEqual(
      expect.arrayContaining(['--bundle', BUNDLE, '--triple', TARGET]),
    );
    expect(
      fixture.calls.some(
        (c) => c.command === 'cargo' && c.args.join(' ') === 'build --locked',
      ),
    ).toBe(true);
  });

  it('publishes nothing when the smoke fails', async () => {
    const fixture = createFixture();
    fixture.exit['/usr/bin/node'] = 1;
    const failed = await runBuild(plan({ smoke: true }), fixture.seams).catch(
      (e) => e as BuildError,
    );
    expect(failed).toMatchObject({ code: 'smoke_failed' });
    expect([...fixture.fs.files.keys()].some((p) => p.startsWith(OUT))).toBe(
      false,
    );
  });
});
