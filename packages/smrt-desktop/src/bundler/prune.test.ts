import {
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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyTree,
  type FilterEntry,
  walkTree,
  withStagedPublish,
} from './paths.js';
import {
  classifyPrune,
  collectEntryPaths,
  createBuildFilter,
  createContentScan,
  createNodeModulesFilter,
  isSecretName,
  locatePackage,
  type PruneTarget,
  scanSecretContent,
} from './prune.js';
import { BundleTreeError } from './tree-errors.js';

// Canary tokens are assembled at runtime so no scanner flags this file.
const CANARY = {
  github: `ghp_${'A1b2'.repeat(9)}`,
  anthropic: `sk-ant-${'x9Y8'.repeat(8)}`,
  slack: `xox${'b'}-${'1234567890-abcdef'}`,
  aws: `AKIA${'ABCDEFGHIJKLMNOP'}`,
  privateKey: `-----BEGIN ${'RSA '}PRIVATE KEY-----`,
  openaiProject: `sk-proj-${'Ab3_'.repeat(10)}`,
  openai: `sk-${'aB3dE6gH'.repeat(6)}`,
  google: `AI${'za'}${'Sy0123456789abcdefghijklmnopqrstuvw'}`,
  npm: `npm_${'a1B2c3D4e5'.repeat(3)}${'f6G7h8'}`,
  stripeLive: `${'s'}k_live_${'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'}`,
  stripeRestricted: `${'r'}k_live_${'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'}`,
};

const darwinArm64: PruneTarget = { platform: 'darwin', arch: 'arm64' };
const linuxX64Glibc: PruneTarget = {
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
};

function entry(rel: string, kind: FilterEntry['kind'] = 'file'): FilterEntry {
  const parts = rel.split('/');
  return {
    rel,
    name: parts[parts.length - 1] as string,
    kind,
    size: 1,
    depth: parts.length,
  };
}

describe('unused scaffold templates', () => {
  it.each([
    'template',
    'templates',
  ])('prunes an unused package-root %s directory, without pruning referenced assets', (folder) => {
    const dir = `@scope/pkg/${folder}`;
    const filter = createNodeModulesFilter();
    expect(filter.filter(entry(dir, 'dir'))).toBe('skip');
    const protectedPaths = new Set([`${dir}/runtime.txt`]);
    expect(
      classifyPrune(entry(dir, 'dir'), { protectedPaths }),
    ).toBeUndefined();
    expect(
      classifyPrune(entry(dir, 'dir'), {
        entryPaths: new Map([['@scope/pkg', [`${folder}/index.js`]]]),
      }),
    ).toBeUndefined();
    const secret = createNodeModulesFilter({
      protectedPaths: new Set([`${dir}/.env.example`]),
    });
    expect(secret.filter(entry(dir, 'dir'))).toBe('keep');
    expect(() => secret.filter(entry(`${dir}/.env.example`))).toThrow(
      BundleTreeError,
    );
    // A nested application asset directory is never classified by this root-only rule.
    expect(
      classifyPrune(entry(`@scope/pkg/lib/${folder}`, 'dir')),
    ).toBeUndefined();
  });
});

describe('locatePackage', () => {
  it('finds the innermost package, scoped or nested', () => {
    expect(locatePackage(['a', 'lib', 'x.js'])).toEqual({
      packageDir: 'a',
      inner: ['lib', 'x.js'],
    });
    expect(locatePackage(['@s', 'p', 'x.js'])).toEqual({
      packageDir: '@s/p',
      inner: ['x.js'],
    });
    expect(
      locatePackage(['a', 'node_modules', '@s', 'p', 'docs', 'x.md']),
    ).toEqual({ packageDir: 'a/node_modules/@s/p', inner: ['docs', 'x.md'] });
    expect(locatePackage(['@s'])).toBeUndefined();
    expect(locatePackage(['a', 'node_modules'])).toBeUndefined();
  });
});

describe('collectEntryPaths', () => {
  it('does not mistake declared copied resources for runtime roots', () => {
    const manifest = {
      main: './index.js',
      exports: { '.': './index.js', './template/*': './template/*' },
      smrt: { resourceExports: ['./template/*'] },
    };
    expect(collectEntryPaths(manifest)).toEqual(['index.js']);
    const filter = createNodeModulesFilter({
      entryPaths: new Map([['@scope/pkg', collectEntryPaths(manifest)]]),
    });
    expect(filter.filter(entry('@scope/pkg/template', 'dir'))).toBe('skip');
    // Invalid or conditional resource declarations never hide runtime roots.
    expect(
      collectEntryPaths({
        ...manifest,
        exports: { './template/*': { import: './template/*.js' } },
      }),
    ).toEqual(['index.js', 'template']);
    expect(
      collectEntryPaths({ ...manifest, smrt: { resourceExports: ['./*'] } }),
    ).toEqual(['index.js', 'template']);
    // Actual imports still protect a resource, irrespective of its declaration.
    const reached = createNodeModulesFilter({
      entryPaths: new Map([['@scope/pkg', collectEntryPaths(manifest)]]),
      protectedPaths: new Set(['@scope/pkg/template/runtime.js']),
    });
    expect(reached.filter(entry('@scope/pkg/template', 'dir'))).toBe('keep');
  });

  it('collects main, module, bin and every exports string', () => {
    expect(
      collectEntryPaths({
        main: './dist/index.js',
        module: 'dist/index.mjs',
        bin: { tool: './bin/tool.js' },
        browser: './browser.js',
        exports: {
          '.': { import: './esm/index.js', require: ['./cjs/index.js'] },
          './runtime': './docs/runtime.js',
          './features/*': './features/*.js',
          './escape': '../outside.js',
        },
      }),
    ).toEqual([
      'bin/tool.js',
      'browser.js',
      'cjs/index.js',
      'dist/index.js',
      'dist/index.mjs',
      'docs/runtime.js',
      'esm/index.js',
      'features',
    ]);
    expect(collectEntryPaths(null)).toEqual([]);
    expect(collectEntryPaths({ bin: 'cli.js' })).toEqual(['cli.js']);
  });
});

describe('secret deny-list names', () => {
  it.each([
    '.env',
    '.ENV',
    '.env.local',
    '.env.production',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.netrc',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'server.pem',
    'tls.KEY',
    'cert.p12',
    'cert.pfx',
    'app.keystore',
    'data.sqlite',
    'data.sqlite3',
    'data.db',
    'data.db-wal',
    '.git',
    '.smrt',
    '.ssh',
    '.aws',
    '.git-credentials',
  ])('flags %s', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    'environment.js',
    '.envrc',
    'env.js',
    'npmrc.md',
    'keyboard.js',
    'monkey.js',
    '.gitignore',
    '.gitattributes',
    'index.db.js',
    'package.json',
    'pem.js',
    'turkey',
  ])('does not flag %s', (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it('treats credentials as secret only when it is a file', () => {
    expect(isSecretName('credentials', 'file')).toBe(true);
    expect(isSecretName('credentials.json', 'file')).toBe(true);
    expect(isSecretName('credentials', 'dir')).toBe(false);
    expect(isSecretName('credentials.js', 'file')).toBe(false);
  });
});

describe('classifyPrune', () => {
  const rule = (rel: string, kind: FilterEntry['kind'] = 'file', opts = {}) =>
    classifyPrune(entry(rel, kind), { target: darwinArm64, ...opts });

  it('prunes types, source, maps, docs, tooling and static libraries', () => {
    expect(rule('p/dist/index.js.map')).toBe('source-map');
    expect(rule('p/dist/index.d.ts')).toBe('types');
    expect(rule('p/dist/index.d.mts')).toBe('types');
    expect(rule('p/dist/index.d.cts')).toBe('types');
    expect(rule('p/src/index.ts')).toBe('typescript-source');
    expect(rule('p/src/index.mts')).toBe('typescript-source');
    expect(rule('p/README.md')).toBe('docs');
    expect(rule('p/README')).toBe('docs');
    expect(rule('p/CHANGELOG')).toBe('docs');
    expect(rule('p/HISTORY.txt')).toBe('docs');
    expect(rule('p/docs/guide.markdown')).toBe('docs');
    expect(rule('p/.npmignore')).toBe('tooling-config');
    expect(rule('p/tsconfig.json')).toBe('tooling-config');
    expect(rule('p/tsconfig.build.json')).toBe('tooling-config');
    expect(rule('p/.eslintrc.cjs')).toBe('tooling-config');
    expect(rule('p/x.tsbuildinfo')).toBe('tooling-config');
    expect(rule('p/libfoo.a')).toBe('static-library');
    expect(rule('p/foo.lib')).toBe('static-library');
    expect(rule('p/foo.pdb')).toBe('static-library');
    expect(rule('p/foo.obj')).toBe('static-library');
    expect(rule('p/.DS_Store')).toBe('os-junk');
  });

  it('keeps what must stay', () => {
    for (const rel of [
      'p/package.json',
      'p/LICENSE',
      'p/LICENSE.md',
      'p/LICENCE',
      'p/NOTICE',
      'p/NOTICE.txt',
      'p/COPYING',
      'p/dist/index.js',
      'p/dist/index.mjs',
      'p/dist/index.cjs',
      'p/lib/addon.node',
      'p/lib/data.json',
      'p/lib/module.wasm',
      'p/readme.js',
      'p/component.svelte',
      'p/tsconfig.js',
      '@s/p/lib/index.js',
    ]) {
      expect(rule(rel), rel).toBeUndefined();
    }
  });

  it('keeps source maps on request', () => {
    expect(
      rule('p/a.js.map', 'file', { keepSourceMaps: true }),
    ).toBeUndefined();
  });

  it('prunes directory rules at the package root only (tests and docs)', () => {
    for (const dir of ['test', 'tests', '__tests__']) {
      expect(rule(`p/${dir}`, 'dir')).toBe('tests');
    }
    for (const dir of ['docs', 'doc', 'example', 'examples']) {
      expect(rule(`p/${dir}`, 'dir')).toBe('docs');
    }
    expect(rule('p/.github', 'dir')).toBe('ci');
    // Nested directories with those names are runtime code until proven otherwise.
    expect(rule('p/lib/test', 'dir')).toBeUndefined();
    expect(rule('p/lib/docs', 'dir')).toBeUndefined();
    // ... except __tests__ and .github, which are never runtime.
    expect(rule('p/lib/__tests__', 'dir')).toBe('tests');
    expect(rule('p/lib/.github', 'dir')).toBe('ci');
    expect(rule('p/x.dSYM', 'dir')).toBe('static-library');
  });

  it('keeps a directory that main, exports or bin points into', () => {
    const entryPaths = new Map([
      ['p', ['docs/runtime.js', 'bin/tool.js', 'test/helper.js']],
    ]);
    expect(rule('p/docs', 'dir', { entryPaths })).toBeUndefined();
    expect(rule('p/test', 'dir', { entryPaths })).toBeUndefined();
    expect(rule('p/examples', 'dir', { entryPaths })).toBe('docs');
    expect(rule('p/lib/__tests__', 'dir', { entryPaths })).toBe('tests');
    // Entry paths are per package: another package's entries do not protect.
    expect(rule('q/docs', 'dir', { entryPaths })).toBe('docs');
  });

  it('prunes foreign prebuilds against the target', () => {
    const dir = (name: string, target = darwinArm64) =>
      classifyPrune(entry(`p/prebuilds/${name}`, 'dir'), { target });
    expect(dir('darwin-arm64')).toBeUndefined();
    expect(dir('darwin-x64+arm64')).toBeUndefined();
    expect(dir('darwin-x64')).toBe('foreign-native');
    expect(dir('linux-arm64')).toBe('foreign-native');
    expect(dir('win32-x64')).toBe('foreign-native');
    expect(dir('android-arm64')).toBe('foreign-native');
    expect(dir('linux-x64', linuxX64Glibc)).toBeUndefined();
    expect(dir('linux-x64-glibc', linuxX64Glibc)).toBeUndefined();
    expect(dir('linux-x64-musl', linuxX64Glibc)).toBe('foreign-native');
    // Not a platform-arch name: left alone.
    expect(dir('universal')).toBeUndefined();
    expect(dir('node-v127')).toBeUndefined();
    // Without a target nothing is pruned by this rule.
    expect(
      classifyPrune(entry('p/prebuilds/win32-x64', 'dir'), {}),
    ).toBeUndefined();
  });

  it('prunes foreign napi-vN directories', () => {
    const dir = (rel: string) =>
      classifyPrune(entry(rel, 'dir'), { target: darwinArm64 });
    expect(dir('p/bin/napi-v3/linux')).toBe('foreign-native');
    expect(dir('p/bin/napi-v3/darwin')).toBeUndefined();
    expect(dir('p/bin/napi-v3/darwin/x64')).toBe('foreign-native');
    expect(dir('p/bin/napi-v3/darwin/arm64')).toBeUndefined();
  });

  it('keeps a pruned-by-name file that a reached module refers to, and a directory only as an entry', () => {
    const protectedPaths = new Set([
      'p/test/setup.js',
      'p/types/shape.d.ts',
      'p/docs/guide.md',
      'q/assets',
    ]);
    const keep = (rel: string, kind: FilterEntry['kind'] = 'file') =>
      rule(rel, kind, { protectedPaths });
    // The file and the directories on the way.
    expect(keep('p/test/setup.js')).toBeUndefined();
    expect(keep('p/test', 'dir')).toBeUndefined();
    expect(keep('p/types/shape.d.ts')).toBeUndefined();
    expect(keep('p/docs/guide.md')).toBeUndefined();
    expect(keep('p/docs', 'dir')).toBeUndefined();
    // A protected directory is kept as an entry, not its contents.
    expect(keep('q/assets', 'dir')).toBeUndefined();
    expect(keep('q/assets/deep/readme.md')).toBe('docs');
    expect(keep('q/assets/types.d.ts')).toBe('types');
    // Siblings that nothing refers to are still pruned.
    expect(keep('p/types/other.d.ts')).toBe('types');
    expect(keep('p/docs/other.md')).toBe('docs');
    expect(keep('p/README.md')).toBe('docs');
    expect(keep('p/examples', 'dir')).toBe('docs');
    expect(rule('p/test', 'dir')).toBe('tests');
    expect(rule('p/test/setup.js', 'file')).toBeUndefined();
    expect(rule('p/types/shape.d.ts')).toBe('types');
  });

  it('a package root a reached module names does not keep its tests, docs or fixtures', () => {
    const protectedPaths = new Set(['p']);
    const keep = (rel: string, kind: FilterEntry['kind'] = 'file') =>
      rule(rel, kind, { protectedPaths });
    expect(keep('p', 'dir')).toBeUndefined();
    expect(keep('p/test', 'dir')).toBe('tests');
    expect(keep('p/docs', 'dir')).toBe('docs');
    expect(keep('p/lib/index.d.ts')).toBe('types');
    expect(keep('p/README.md')).toBe('docs');
  });

  it('keeps everything below an explicit asset directory, and the directories on the way', () => {
    const protectedSubtrees = new Set(['q/assets']);
    const protectedPaths = new Set(['q/assets']);
    const keep = (rel: string, kind: FilterEntry['kind'] = 'file') =>
      rule(rel, kind, { protectedPaths, protectedSubtrees });
    expect(keep('q/assets', 'dir')).toBeUndefined();
    expect(keep('q/assets/deep', 'dir')).toBeUndefined();
    expect(keep('q/assets/deep/readme.md')).toBeUndefined();
    expect(keep('q/assets/types.d.ts')).toBeUndefined();
    expect(keep('q/docs', 'dir')).toBe('docs');
    expect(keep('q/assets2/readme.md')).toBe('docs');
    // A directory only on the way keeps its entry, not its other contents.
    const nested = new Set(['q/vendor/assets']);
    expect(
      rule('q/vendor', 'dir', { protectedSubtrees: nested }),
    ).toBeUndefined();
    expect(
      rule('q/vendor/readme.md', 'file', { protectedSubtrees: nested }),
    ).toBe('docs');
  });

  it('does not let protection override a removed package or a foreign native directory', () => {
    const protectedPaths = new Set(['big/lib/x.js', 'p/prebuilds/linux-x64']);
    expect(
      classifyPrune(entry('big', 'dir'), {
        removedDirs: new Set(['big']),
        protectedPaths,
      }),
    ).toBe('removed-package');
    expect(
      classifyPrune(entry('p/prebuilds/linux-x64', 'dir'), {
        target: darwinArm64,
        protectedPaths,
      }),
    ).toBe('foreign-native');
  });

  it('prunes removed package directories first', () => {
    expect(
      classifyPrune(entry('big', 'dir'), { removedDirs: new Set(['big']) }),
    ).toBe('removed-package');
    expect(
      classifyPrune(entry('a/node_modules/big', 'dir'), {
        removedDirs: new Set(['a/node_modules/big']),
      }),
    ).toBe('removed-package');
    expect(
      classifyPrune(entry('other', 'dir'), { removedDirs: new Set(['big']) }),
    ).toBeUndefined();
  });
});

describe('golden prune list on a real tree', () => {
  let base: string;
  let modules: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-prune-')));
    modules = join(base, 'node_modules');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (rel: string, content = 'x') => {
    const path = join(modules, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  function buildFixture() {
    const files = [
      'lib/package.json',
      'lib/dist/index.js',
      'lib/dist/index.js.map',
      'lib/dist/index.d.ts',
      'lib/src/index.ts',
      'lib/README.md',
      'lib/CHANGELOG.md',
      'lib/LICENSE',
      'lib/LICENSE.md',
      'lib/NOTICE',
      'lib/docs/guide.md',
      'lib/docs/runtime.js',
      'lib/test/a.js',
      'lib/tests/b.js',
      'lib/lib/__tests__/c.js',
      'lib/lib/test/helper.js',
      'lib/example/e.js',
      'lib/.github/workflows/ci.yml',
      'lib/.npmignore',
      'lib/tsconfig.json',
      'lib/.DS_Store',
      'lib/native.a',
      'lib/x.dSYM/Contents/Info.plist',
      'lib/prebuilds/darwin-arm64/n.node',
      'lib/prebuilds/darwin-x64/n.node',
      'lib/prebuilds/linux-x64-musl/n.node',
      'lib/prebuilds/win32-x64/n.node',
      'lib/prebuilds/darwin-x64+arm64/n.node',
      'lib/bin/napi-v3/darwin/arm64/x.node',
      'lib/bin/napi-v3/darwin/x64/x.node',
      'lib/bin/napi-v3/linux/x64/x.node',
      '@s/p/package.json',
      '@s/p/index.js',
      '@s/p/index.d.ts',
      '@s/p/README.md',
      'big/package.json',
      'big/index.js',
      'lib/node_modules/inner/package.json',
      'lib/node_modules/inner/index.js',
      'lib/node_modules/inner/index.d.ts',
      'lib/node_modules/inner/docs/a.md',
    ];
    for (const file of files) put(file);
    writeFileSync(
      join(modules, 'lib/package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        main: './dist/index.js',
        exports: { '.': './dist/index.js', './runtime': './docs/runtime.js' },
      }),
    );
  }

  it('keeps exactly the expected files', async () => {
    buildFixture();
    const entryPaths = new Map([
      [
        'lib',
        collectEntryPaths(
          JSON.parse(readFileSync(join(modules, 'lib/package.json'), 'utf8')),
        ),
      ],
    ]);
    const pruner = createNodeModulesFilter({
      target: darwinArm64,
      entryPaths,
      removedDirs: new Set(['big']),
    });
    const result = await walkTree({
      root: modules,
      filter: pruner.filter,
      dropEmptyDirectories: true,
    });
    expect(
      result.entries.filter((e) => e.kind === 'file').map((e) => e.rel),
    ).toEqual([
      '@s/p/index.js',
      '@s/p/package.json',
      'lib/LICENSE',
      'lib/LICENSE.md',
      'lib/NOTICE',
      'lib/bin/napi-v3/darwin/arm64/x.node',
      'lib/dist/index.js',
      'lib/docs/runtime.js',
      'lib/lib/test/helper.js',
      'lib/node_modules/inner/index.js',
      'lib/node_modules/inner/package.json',
      'lib/package.json',
      'lib/prebuilds/darwin-arm64/n.node',
      'lib/prebuilds/darwin-x64+arm64/n.node',
    ]);
    expect(pruner.summary()).toEqual({
      'removed-package': 1,
      'source-map': 1,
      types: 3,
      'typescript-source': 1,
      docs: 6,
      tests: 3,
      ci: 1,
      'tooling-config': 2,
      'os-junk': 1,
      'static-library': 2,
      'foreign-native': 5,
    });
    // Directories left empty by pruning are not created.
    expect(
      result.entries.filter((e) => e.kind === 'dir').map((e) => e.rel),
    ).not.toContain('lib/src');
  });

  it('copies only the kept files and accounts the pruned bytes', async () => {
    buildFixture();
    const out = join(base, 'out');
    mkdirSync(out);
    const pruner = createNodeModulesFilter({
      target: darwinArm64,
      removedDirs: new Set(['big']),
    });
    const result = await copyTree({
      root: modules,
      destRoot: out,
      filter: pruner.filter,
      dropEmptyDirectories: true,
      accountSkipped: true,
    });
    expect(result.skipped.files).toBeGreaterThan(20);
    expect(result.skipped.bytes).toBe(result.skipped.files); // 1-byte files
    expect(() => statSync(join(out, 'big'))).toThrow();
    expect(() => statSync(join(out, 'lib/dist/index.js.map'))).toThrow();
    expect(statSync(join(out, 'lib/dist/index.js')).isFile()).toBe(true);
  });

  it('a deny-listed file inside a pruned directory is dropped with it; inside a kept one it fails', async () => {
    put('lib/package.json', '{}');
    put('lib/test/.env', 'SECRET=1');
    const ok = await walkTree({
      root: modules,
      filter: createNodeModulesFilter({ target: darwinArm64 }).filter,
    });
    expect(ok.entries.map((e) => e.rel)).toEqual(['lib', 'lib/package.json']);

    put('lib/lib/.env', 'SECRET=1');
    const error = await walkTree({
      root: modules,
      filter: createNodeModulesFilter({ target: darwinArm64 }).filter,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BundleTreeError);
    expect(error.code).toBe('secret_file');
    expect(error.subjects).toEqual(['lib/lib/.env']);
  });

  it('allows an explicitly listed deny-listed path and nothing else', async () => {
    put('certs/package.json', '{}');
    put('certs/ca.pem', 'public ca bundle');
    put('certs/other.pem', 'other');
    const filter = createNodeModulesFilter({
      secrets: { allow: new Set(['certs/ca.pem']) },
    }).filter;
    const error = await walkTree({ root: modules, filter }).catch((e) => e);
    expect(error.code).toBe('secret_file');
    expect(error.subjects).toEqual(['certs/other.pem']);
  });
});

describe('secrets in the application build', () => {
  let base: string;
  let build: string;
  let out: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-secrets-')));
    build = join(base, 'build');
    out = join(base, 'out');
    mkdirSync(build);
    mkdirSync(out);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (rel: string, content = 'x') => {
    const path = join(build, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  /** Every byte of every file under `dir`, to prove a canary is absent. */
  function allBytes(dir: string): string {
    let text = '';
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      text += name.name;
      text += name.isDirectory()
        ? allBytes(path)
        : readFileSync(path, 'latin1');
    }
    return text;
  }

  it.each([
    ['.env', '.env'],
    ['.env.production', '.env.production'],
    ['.npmrc', '.npmrc'],
    ['server/.npmrc', '.npmrc'],
    ['key.pem', 'key.pem'],
    ['id_rsa', 'id_rsa'],
    ['.smrt/data.json', '.smrt'],
    ['data/app.sqlite', 'app.sqlite'],
    ['.git/config', '.git'],
  ])('fails when the build contains %s, and no canary reaches the output', async (rel, hit) => {
    put('index.js', 'console.log(1)');
    put(rel, `//registry.npmjs.org/:_authToken=${CANARY.github}`);
    const error = await copyTree({
      root: build,
      destRoot: out,
      filter: createBuildFilter().filter,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BundleTreeError);
    expect(error.code).toBe('secret_file');
    expect(error.subjects[0].endsWith(hit)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(CANARY.github);
    expect(error.message).not.toContain(CANARY.github);
    // The walk fails before anything is copied.
    expect(allBytes(out)).not.toContain(CANARY.github);
    expect(readdirSync(out)).toEqual([]);
  });

  it('drops source maps and .DS_Store by default, keeps maps on request', async () => {
    put('index.js');
    put('index.js.map');
    put('.DS_Store');
    const dropped = await walkTree({
      root: build,
      filter: createBuildFilter().filter,
    });
    expect(dropped.entries.map((e) => e.rel)).toEqual(['index.js']);
    const kept = await walkTree({
      root: build,
      filter: createBuildFilter({ keepSourceMaps: true }).filter,
    });
    expect(kept.entries.map((e) => e.rel)).toEqual([
      'index.js',
      'index.js.map',
    ]);
  });

  describe('content scan', () => {
    const cases: [string, string, string][] = [
      ['github', CANARY.github, 'github-token'],
      ['anthropic', CANARY.anthropic, 'anthropic-key'],
      ['slack', CANARY.slack, 'slack-token'],
      ['aws', CANARY.aws, 'aws-access-key'],
      ['private key', CANARY.privateKey, 'private-key'],
      ['openai project', CANARY.openaiProject, 'openai-project-key'],
      ['openai', CANARY.openai, 'openai-key'],
      ['google api', CANARY.google, 'google-api-key'],
      ['npm', CANARY.npm, 'npm-token'],
      ['stripe live', CANARY.stripeLive, 'stripe-live-key'],
      ['stripe restricted live', CANARY.stripeRestricted, 'stripe-live-key'],
    ];

    it.each(
      cases,
    )('fails on a %s token in the build and publishes nothing', async (_name, token, id) => {
      put('index.js', 'ok');
      put('chunks/app.js', `const t = "${token}";`);
      const scan = createContentScan();
      const final = join(base, 'bundle');
      const error = await withStagedPublish(final, async (staging) => {
        const dest = join(staging.path, 'build');
        await copyTree({
          root: build,
          destRoot: dest,
          createRoot: true,
          filter: createBuildFilter().filter,
          inspect: scan.inspect,
        });
      }).catch((e) => e);
      expect(error).toBeInstanceOf(BundleTreeError);
      expect(error.code).toBe('secret_content');
      expect(error.subjects).toEqual(['chunks/app.js']);
      expect(JSON.stringify(error)).not.toContain(token);
      expect(error.stack ?? '').not.toContain(token);
      expect(readdirSync(base).sort()).toEqual(['build', 'out']);
      expect(scanSecretContent(Buffer.from(token))).toEqual([id]);
    });

    it('with policy warn, reports pattern ids only and still copies', async () => {
      put('app.js', `x("${CANARY.github}");`);
      const scan = createContentScan({ policy: 'warn' });
      await copyTree({ root: build, destRoot: out, inspect: scan.inspect });
      expect(scan.findings).toEqual([
        { rel: 'app.js', patterns: ['github-token'] },
      ]);
      expect(JSON.stringify(scan.findings)).not.toContain(CANARY.github);
      expect(readFileSync(join(out, 'app.js'), 'utf8')).toContain('ghp_');
    });

    it('finds a token split across the copy chunk boundary', async () => {
      const padding = 'a'.repeat(64 * 1024 - 10);
      put('big.js', `${padding}"${CANARY.github}"${padding}`);
      const scan = createContentScan();
      const code = await copyTree({
        root: build,
        destRoot: out,
        inspect: scan.inspect,
      }).catch((e) => e.code);
      expect(code).toBe('secret_content');
    });

    it('scans kept source maps', async () => {
      put('app.js.map', JSON.stringify({ sourcesContent: [CANARY.aws] }));
      const scan = createContentScan();
      const code = await copyTree({
        root: build,
        destRoot: out,
        filter: createBuildFilter({ keepSourceMaps: true }).filter,
        inspect: scan.inspect,
      }).catch((e) => e.code);
      expect(code).toBe('secret_content');
    });

    it('finds the OpenAI, Google, npm and Stripe token shapes and reports only ids', () => {
      const expected: [string, string][] = [
        [CANARY.openaiProject, 'openai-project-key'],
        [CANARY.openai, 'openai-key'],
        [CANARY.google, 'google-api-key'],
        [CANARY.npm, 'npm-token'],
        [CANARY.stripeLive, 'stripe-live-key'],
        [CANARY.stripeRestricted, 'stripe-live-key'],
      ];
      for (const [token, id] of expected) {
        const ids = scanSecretContent(Buffer.from(`const k = "${token}";`));
        expect(ids).toEqual([id]);
        expect(JSON.stringify(ids)).not.toContain(token);
      }
    });

    it('does not flag ordinary code or look-alikes', () => {
      for (const text of [
        'const sk = "sk-ant-short"',
        'ghp_short',
        'AKIAlowercaseisnotakey',
        'xoxb-',
        '-----BEGIN CERTIFICATE-----',
        'github_pat_',
        'function ghp_() {}',
        'a'.repeat(100_000),
        // Realistic non-secrets that share a prefix or a shape.
        'sk-proj-short',
        `task-${'a1b2c3d4'.repeat(6)}`,
        `risk-${'f'.repeat(40)}`,
        `sk-${'a1b2c3d4-'.repeat(6)}`,
        `sk-${'ab'.repeat(15)}`,
        `sha512-${'Qm9vYmFy'.repeat(10)}==`,
        `sha1-${'0123456789abcdef'.repeat(2)}`,
        '5f2b1c0e-8a43-4d6b-9c3e-7d1a2b3c4d5e',
        'a'.repeat(32) + 'b'.repeat(32),
        'AIza',
        `AIzaSy${'a'.repeat(20)}`,
        `npm_${'a'.repeat(20)}`,
        `npm_${'a1B2'.repeat(10)}`,
        'npm_config_registry',
        `rk_live_${'a'.repeat(5)}`,
        `sk_test_${'a1B2'.repeat(8)}`,
        'pk_live_' + 'a1B2'.repeat(8),
      ]) {
        expect(scanSecretContent(Buffer.from(text)), text.slice(0, 30)).toEqual(
          [],
        );
      }
    });

    it('skips binary files and files above the scan cap', async () => {
      put('addon.node', CANARY.github);
      put('huge.js', CANARY.github + 'x'.repeat(100));
      const scan = createContentScan({ maxScanBytes: 50 });
      await copyTree({ root: build, destRoot: out, inspect: scan.inspect });
      expect(scan.findings).toEqual([]);
    });

    it('honours an include gate', async () => {
      put('a.js', CANARY.github);
      put('b.js', 'fine');
      const scan = createContentScan({
        include: (e) => e.rel !== 'a.js',
      });
      await copyTree({ root: build, destRoot: out, inspect: scan.inspect });
      expect(scan.findings).toEqual([]);
    });
  });
});
