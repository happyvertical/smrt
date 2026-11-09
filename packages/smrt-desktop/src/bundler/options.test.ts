import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BundleOptionsInput,
  createBundlePlan,
  hostTriple,
  parseTargetTriple,
} from './options.js';
import { BundleTreeError } from './tree-errors.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const config = {
  version: 1,
  productId: 'smrt-start',
  bundleId: 'com.happyvertical.smrt-start',
  displayName: 'SMRT Start',
  bridge: { envPrefix: 'SMRT_START', mcpPath: '/api/mcp' },
  features: { default: ['ai-providers'] },
  exclude: ['moment'],
  maxSizeMB: 350,
  acknowledgedDynamicImports: [{ from: 'ws', specifier: 'bufferutil' }],
};

describe('target triples', () => {
  it.each([
    ['aarch64-apple-darwin', 'darwin', 'arm64', undefined],
    ['x86_64-apple-darwin', 'darwin', 'x64', undefined],
    ['aarch64-unknown-linux-gnu', 'linux', 'arm64', 'glibc'],
    ['x86_64-unknown-linux-gnu', 'linux', 'x64', 'glibc'],
    ['x86_64-pc-windows-msvc', 'win32', 'x64', undefined],
    ['aarch64-pc-windows-msvc', 'win32', 'arm64', undefined],
  ])('parses %s', (triple, os, arch, libc) => {
    const target = parseTargetTriple(triple);
    expect(target).toMatchObject({ triple, os, arch });
    expect(target?.libc).toBe(libc);
  });

  it.each([
    'universal-apple-darwin',
    'x86_64-unknown-linux-musl',
    'aarch64-unknown-linux-musl',
    'i686-pc-windows-msvc',
    'x86_64-pc-windows-gnu',
    'armv7-unknown-linux-gnueabihf',
    'x86_64-apple-darwin; rm -rf /',
    '',
  ])('does not support %j', (triple) => {
    expect(parseTargetTriple(triple)).toBeUndefined();
  });

  it('derives the host triple', () => {
    expect(hostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(hostTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(hostTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(hostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(hostTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(hostTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
    expect(hostTriple('freebsd', 'x64')).toBeUndefined();
    expect(hostTriple('linux', 'ia32')).toBeUndefined();
  });
});

posixOnly('createBundlePlan', () => {
  let base: string;
  let app: string;
  let out: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-plan-')));
    app = join(base, 'app');
    out = join(base, 'out');
    mkdirSync(join(app, 'build'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'start', version: '1.2.3' }),
    );
    writeFileSync(join(app, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(join(app, 'smrt-desktop.json'), JSON.stringify(config));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const env = { platform: 'darwin' as const, arch: 'arm64' };
  const plan = (input: Partial<BundleOptionsInput> = {}) =>
    createBundlePlan({ appDir: app, outDir: out, ...input }, env);

  async function code(input: Partial<BundleOptionsInput>): Promise<string> {
    try {
      await plan(input);
    } catch (error) {
      expect(error).toBeInstanceOf(BundleTreeError);
      return (error as BundleTreeError).code;
    }
    return 'ok';
  }
  async function field(input: Partial<BundleOptionsInput>): Promise<unknown> {
    try {
      await plan(input);
    } catch (error) {
      return (error as BundleTreeError).field;
    }
    return undefined;
  }

  it('produces a frozen plan from the product configuration', async () => {
    const result = await plan();
    expect(result).toMatchObject({
      version: 1,
      appDir: app,
      buildDir: join(app, 'build'),
      outDir: out,
      productConfigPath: join(app, 'smrt-desktop.json'),
      target: { triple: 'aarch64-apple-darwin', os: 'darwin', arch: 'arm64' },
      product: {
        productId: 'smrt-start',
        bundleId: 'com.happyvertical.smrt-start',
        displayName: 'SMRT Start',
        productVersion: '1.2.3',
        channel: 'stable',
      },
      sidecar: {
        executable: 'smrt-start-node',
        args: ['app/build/index.js'],
        healthRoute: '/api/_runtime/health',
        dataDirectory: 'runtime',
      },
      bridge: { envPrefix: 'SMRT_START', mcpPath: '/api/mcp' },
      maxSizeBytes: 350 * 1024 * 1024,
      keepSourceMaps: false,
      offline: false,
      force: false,
      measure: false,
      secretContentPolicy: 'fail',
      node: {},
    });
    expect(result.features.enabled).toEqual(['ai-providers']);
    expect(result.features.disabled.at(-1)).toEqual({
      label: 'exclude',
      patterns: ['moment'],
    });
    expect(result.acknowledgedDynamicImports).toEqual([
      { from: 'ws', specifier: 'bufferutil' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.product)).toBe(true);
    expect(Object.isFrozen(result.features.disabled)).toBe(true);
    expect(() => {
      (result.product as { productId: string }).productId = 'x';
    }).toThrow(TypeError);
  });

  it('lets flags win over the product configuration', async () => {
    const result = await plan({
      productId: 'other',
      bundleId: 'com.example.other',
      displayName: 'Other',
      productVersion: '9.9.9-beta.1',
      channel: 'beta',
      maxSizeMB: 100,
      target: 'x86_64-pc-windows-msvc',
      nodeVersion: '26.8.1',
      features: ['images'],
      keepSourceMaps: true,
      offline: true,
      measure: true,
      secretContentPolicy: 'warn',
    });
    expect(result.product).toEqual({
      productId: 'other',
      bundleId: 'com.example.other',
      displayName: 'Other',
      productVersion: '9.9.9-beta.1',
      channel: 'beta',
    });
    // The sidecar name follows the product id, never the config.
    expect(result.sidecar.executable).toBe('other-node');
    expect(result.maxSizeBytes).toBe(100 * 1024 * 1024);
    expect(result.target.os).toBe('win32');
    expect(result.node.version).toBe('26.8.1');
    expect(result.features.enabled).toEqual(['ai-providers', 'images']);
    expect(result).toMatchObject({
      keepSourceMaps: true,
      offline: true,
      measure: true,
      secretContentPolicy: 'warn',
    });
  });

  it('resolves the prepared measurement data directory', async () => {
    const result = await plan({ measure: true, measureDataDir: 'prepared' });
    expect(result.measureDataDir).toBe(join(process.cwd(), 'prepared'));
    expect((await plan({})).measureDataDir).toBeUndefined();
    expect(await field({ measureDataDir: '' })).toBe('measureData');
  });

  it('resolves the bridge file to an absolute path', async () => {
    const result = await plan({ bridgeFile: 'bridge.mjs' });
    expect(result.bridgeFile).toBe(join(process.cwd(), 'bridge.mjs'));
    expect((await plan({})).bridgeFile).toBeUndefined();
    expect(await field({ bridgeFile: '' })).toBe('bridge');
  });

  it('works without a configuration file when flags give the identity', async () => {
    rmSync(join(app, 'smrt-desktop.json'));
    const result = await plan({
      productId: 'notes',
      bundleId: 'com.example.notes',
      displayName: 'Notes',
    });
    expect(result.productConfigPath).toBeUndefined();
    expect(result.bridge).toBeUndefined();
    expect(result.features.enabled).toEqual([]);
    expect(result.maxSizeBytes).toBeUndefined();
    expect(await field({})).toBe('productId');
  });

  it('defaults the target to the host and resolves relative paths against cwd', async () => {
    const linux = await createBundlePlan(
      { appDir: 'app', outDir: 'out', buildDir: 'app/build' },
      { platform: 'linux', arch: 'x64', cwd: base },
    );
    expect(linux.target.triple).toBe('x86_64-unknown-linux-gnu');
    expect(linux.appDir).toBe(app);
    expect(linux.outDir).toBe(out);
    expect(
      await createBundlePlan(
        { appDir: app, outDir: out },
        { platform: 'freebsd', arch: 'x64' },
      ).catch((e) => (e as BundleTreeError).field),
    ).toBe('target');
  });

  describe('identity and option negatives', () => {
    it.each([
      ['productId', { productId: 'Not A Slug' }],
      ['productId', { productId: '' }],
      ['bundleId', { bundleId: 'nodots' }],
      ['displayName', { displayName: 'bad\u0000name' }],
      ['displayName', { displayName: '' }],
      ['productVersion', { productVersion: '1.2' }],
      ['productVersion', { productVersion: 'v1.2.3' }],
      ['channel', { channel: 'Beta' }],
      ['channel', { channel: '' }],
      ['target', { target: 'nope' }],
      ['target', { target: 'x86_64 apple darwin' }],
      ['nodeVersion', { nodeVersion: '26' }],
      ['nodeVersion', { nodeVersion: 'v26.8.1' }],
      ['nodeVersion', { nodeVersion: '26.8.1/../x' }],
      ['maxSizeMB', { maxSizeMB: 0 }],
      ['maxSizeMB', { maxSizeMB: 2.5 }],
      ['maxSizeMB', { maxSizeMB: 100_001 }],
      ['features', { features: ['toolchain'] }],
      ['features', { features: ['nope'] }],
      ['secretContentPolicy', { secretContentPolicy: 'off' as 'fail' }],
      ['nodeArchive', { nodeArchive: '' }],
      ['nodeCache', { nodeCache: 'a\0b' }],
    ])('rejects an invalid %s', async (name, input) => {
      expect(await code(input)).toBe('invalid_option');
      expect(await field(input)).toBe(name);
    });

    it('rejects an unsupported but well-formed target as unsupported_target', async () => {
      for (const target of [
        'universal-apple-darwin',
        'x86_64-unknown-linux-musl',
        'i686-pc-windows-msvc',
      ]) {
        expect(await code({ target })).toBe('unsupported_target');
      }
    });

    it('does not echo option values in errors', async () => {
      const error = await plan({ productId: 'LEAK-ME' }).catch((e) => e);
      expect(JSON.stringify(error)).not.toContain('LEAK-ME');
    });

    it('reads the product version from package.json when not given', async () => {
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({ name: 'x', version: 'not-semver' }),
      );
      expect(await field({})).toBe('productVersion');
      expect(
        (await plan({ productVersion: '1.0.0' })).product.productVersion,
      ).toBe('1.0.0');
    });
  });

  describe('application files', () => {
    it('requires package.json, the lockfile and the build directory', async () => {
      rmSync(join(app, 'pnpm-lock.yaml'));
      expect(await code({})).toBe('missing_app_file');
      writeFileSync(join(app, 'pnpm-lock.yaml'), '');
      rmSync(join(app, 'package.json'));
      expect(await code({})).toBe('missing_app_file');
      writeFileSync(join(app, 'package.json'), '{not json');
      expect(await code({})).toBe('invalid_package_json');
      writeFileSync(join(app, 'package.json'), '{"version":"1.0.0"}');
      rmSync(join(app, 'build'), { recursive: true });
      expect(await code({})).toBe('missing_app_file');
    });

    it('rejects an application directory that does not exist', async () => {
      expect(await field({ appDir: join(base, 'missing') })).toBe('app');
      expect(await field({ appDir: join(app, 'package.json') })).toBe('app');
    });

    it('rejects a build directory outside the application', async () => {
      mkdirSync(join(base, 'elsewhere'));
      expect(await code({ buildDir: join(base, 'elsewhere') })).toBe(
        'build_outside_app',
      );
      expect(await code({ buildDir: join(app, '..', 'elsewhere') })).toBe(
        'build_outside_app',
      );
      expect(await code({ buildDir: app })).toBe('build_outside_app');
      expect(await code({ buildDir: join(base, 'app-sibling') })).toBe(
        'build_outside_app',
      );
    });

    it('rejects a build directory that is a symlink out of the application', async () => {
      mkdirSync(join(base, 'elsewhere'));
      rmSync(join(app, 'build'), { recursive: true });
      symlinkSync(join(base, 'elsewhere'), join(app, 'build'));
      expect(await code({})).toBe('build_outside_app');
    });

    it('accepts a build directory in a subfolder', async () => {
      mkdirSync(join(app, 'dist/web'), { recursive: true });
      const result = await plan({ buildDir: join(app, 'dist/web') });
      expect(result.buildDir).toBe(join(app, 'dist/web'));
    });
  });

  describe('product configuration file', () => {
    it('requires an explicitly named file to exist and be inside the application', async () => {
      expect(await code({ productConfigPath: join(app, 'missing.json') })).toBe(
        'missing_app_file',
      );
      writeFileSync(join(base, 'outside.json'), JSON.stringify(config));
      expect(
        await field({ productConfigPath: join(base, 'outside.json') }),
      ).toBe('productConfig');
    });

    it('reads an explicitly named file', async () => {
      writeFileSync(
        join(app, 'custom.json'),
        JSON.stringify({ ...config, productId: 'custom-id' }),
      );
      const result = await plan({
        productConfigPath: join(app, 'custom.json'),
      });
      expect(result.product.productId).toBe('custom-id');
    });

    it('surfaces configuration errors with their own codes', async () => {
      writeFileSync(
        join(app, 'smrt-desktop.json'),
        '{"version":1,"version":1}',
      );
      expect(await code({})).toBe('config_duplicate_keys');
      writeFileSync(join(app, 'smrt-desktop.json'), '{"version":2}');
      expect(await code({})).toBe('config_unsupported_version');
    });
  });

  describe('output directory', () => {
    it('accepts a missing or empty directory', async () => {
      expect((await plan()).outDir).toBe(out);
      mkdirSync(out);
      expect((await plan()).outDir).toBe(out);
    });

    it('refuses a non-empty directory unless forced', async () => {
      mkdirSync(out);
      writeFileSync(join(out, 'old'), 'x');
      expect(await code({})).toBe('out_dir_not_empty');
      expect((await plan({ force: true })).force).toBe(true);
    });

    it('refuses an output that is a symlink or a file, even when forced', async () => {
      mkdirSync(join(base, 'real'));
      symlinkSync(join(base, 'real'), out);
      expect(await code({})).toBe('destination_exists');
      expect(await code({ force: true })).toBe('destination_exists');
      rmSync(out);
      writeFileSync(out, 'a file');
      expect(await code({ force: true })).toBe('destination_exists');
    });

    it('resolves symlinked ancestors of the output', async () => {
      mkdirSync(join(base, 'real'));
      symlinkSync(join(base, 'real'), join(base, 'via'));
      const result = await plan({ outDir: join(base, 'via', 'bundle') });
      expect(result.outDir).toBe(join(base, 'real', 'bundle'));
    });

    it('refuses an output inside the source tree', async () => {
      for (const target of [
        join(app, 'out'),
        join(app, 'build', 'out'),
        join(app, 'node_modules', 'out'),
        app,
        join(app, 'build'),
      ]) {
        expect(await code({ outDir: target })).toBe('out_dir_inside_source');
      }
    });

    it('refuses an output that contains the source tree', async () => {
      expect(await code({ outDir: base })).toBe('out_dir_inside_source');
    });

    it('refuses an output reached through a symlink into the source tree', async () => {
      symlinkSync(app, join(base, 'sneaky'));
      expect(await code({ outDir: join(base, 'sneaky', 'out') })).toBe(
        'out_dir_inside_source',
      );
    });

    it('refuses an output whose parent does not exist', async () => {
      expect(await field({ outDir: join(base, 'no', 'such', 'out') })).toBe(
        'out',
      );
    });

    it('treats a sibling with a common prefix as outside the source tree', async () => {
      const result = await plan({ outDir: join(base, 'app-out') });
      expect(result.outDir).toBe(join(base, 'app-out'));
    });
  });

  it('records node archive and cache as absolute paths', async () => {
    const result = await createBundlePlan(
      {
        appDir: app,
        outDir: out,
        nodeArchive: 'node.tar.gz',
        nodeCache: join(base, 'cache'),
      },
      { ...env, cwd: base },
    );
    expect(result.node).toEqual({
      archive: join(base, 'node.tar.gz'),
      cache: join(base, 'cache'),
    });
  });
});
