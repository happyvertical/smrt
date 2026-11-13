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
  APP_ROOT,
  assertNoMissingDependencies,
  assertRegistryDependencies,
  buildDependencyGraph,
  computeSegmentation,
  createRemovalChecker,
  type DependencyGraph,
  entryPathsByDir,
  findNonRegistryDependencies,
  type InstalledPackage,
  isPackagePattern,
  isRegistrySpecifier,
  matchPackageName,
  packagesNeedingBuild,
  readInstalledPackages,
} from './graph.js';
import { BundleTreeError } from './tree-errors.js';

interface Spec {
  name: string;
  version?: string;
  deps?: string[];
  optional?: string[];
  peer?: string[];
  scripts?: Record<string, string>;
  main?: string;
  nested?: Spec[];
}

function writeSpec(container: string, spec: Spec): void {
  const dir = join(container, spec.name);
  mkdirSync(dir, { recursive: true });
  const record: Record<string, unknown> = {
    name: spec.name,
    version: spec.version ?? '1.0.0',
  };
  const map = (names: string[] | undefined) =>
    Object.fromEntries((names ?? []).map((name) => [name, '^1.0.0']));
  if (spec.deps) record.dependencies = map(spec.deps);
  if (spec.optional) record.optionalDependencies = map(spec.optional);
  if (spec.peer) record.peerDependencies = map(spec.peer);
  if (spec.scripts) record.scripts = spec.scripts;
  if (spec.main) record.main = spec.main;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(record));
  writeFileSync(join(dir, 'index.js'), '');
  for (const nested of spec.nested ?? []) {
    writeSpec(join(dir, 'node_modules'), nested);
  }
}

describe('graph on a hoisted tree', () => {
  let base: string;
  let modules: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-graph-')));
    modules = join(base, 'node_modules');
    mkdirSync(modules);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const install = (specs: Spec[]) => {
    for (const spec of specs) writeSpec(modules, spec);
  };
  const graphOf = async (roots: string[]): Promise<DependencyGraph> =>
    buildDependencyGraph(await readInstalledPackages(modules), roots);

  it('reads scoped and nested packages, skipping hidden entries', async () => {
    install([
      { name: '@scope/a', nested: [{ name: 'inner', version: '2.0.0' }] },
      { name: 'b' },
    ]);
    mkdirSync(join(modules, '.bin'));
    symlinkSync('../b/index.js', join(modules, '.bin/tool'));
    writeFileSync(join(modules, '.package-lock.json'), '{}');
    mkdirSync(join(modules, '.pnpm', 'x'), { recursive: true });
    const packages = await readInstalledPackages(modules);
    expect(packages.map((pkg) => pkg.id)).toEqual([
      'node_modules/@scope/a',
      'node_modules/@scope/a/node_modules/inner',
      'node_modules/b',
    ]);
    expect(packages[1]).toMatchObject({
      dir: '@scope/a/node_modules/inner',
      installName: 'inner',
      version: '2.0.0',
    });
  });

  it('refuses a symlinked package or container and bad manifests', async () => {
    install([{ name: 'a' }]);
    symlinkSync(join(modules, 'a'), join(modules, 'link'));
    expect(
      await readInstalledPackages(modules).catch(
        (e) => (e as BundleTreeError).code,
      ),
    ).toBe('symlink_refused');
    rmSync(join(modules, 'link'));

    mkdirSync(join(modules, 'nomanifest'));
    expect(
      await readInstalledPackages(modules).catch(
        (e) => (e as BundleTreeError).code,
      ),
    ).toBe('invalid_package_json');
    rmSync(join(modules, 'nomanifest'), { recursive: true });

    for (const body of [
      '{not json',
      '[]',
      '{"name":"x"}',
      '{"name":"x","version":"1","dependencies":{"a":1}}',
      '{"name":"x","version":"1","dependencies":[]}',
    ]) {
      mkdirSync(join(modules, 'bad'));
      writeFileSync(join(modules, 'bad/package.json'), body);
      const error = await readInstalledPackages(modules).catch((e) => e);
      expect(error).toBeInstanceOf(BundleTreeError);
      expect(error.code).toBe('invalid_package_json');
      expect(error.subjects).toEqual(['bad']);
      rmSync(join(modules, 'bad'), { recursive: true });
    }
  });

  it('resolves with Node lookup order: nested first, then upward', async () => {
    install([
      {
        name: 'a',
        deps: ['shared'],
        nested: [{ name: 'shared', version: '2.0.0' }],
      },
      { name: 'b', deps: ['shared'] },
      { name: 'shared', version: '1.0.0' },
    ]);
    const graph = await graphOf(['a', 'b']);
    expect(graph.resolve('node_modules/a', 'shared')).toBe(
      'node_modules/a/node_modules/shared',
    );
    expect(graph.resolve('node_modules/b', 'shared')).toBe(
      'node_modules/shared',
    );
    expect(graph.resolve(APP_ROOT, 'shared')).toBe('node_modules/shared');
    expect(graph.resolve(APP_ROOT, 'absent')).toBeUndefined();
    expect(graph.resolve('node_modules/a/node_modules/shared', 'b')).toBe(
      'node_modules/b',
    );
  });

  it('records missing required dependencies but not optional or peer ones', async () => {
    install([
      {
        name: 'a',
        deps: ['gone'],
        optional: ['maybe'],
        peer: ['peerless'],
      },
    ]);
    const graph = await graphOf(['a']);
    expect(graph.missing).toEqual([{ from: 'node_modules/a', name: 'gone' }]);
    expect(() => assertNoMissingDependencies(graph)).toThrow(BundleTreeError);
  });

  it('checks the retained closure without requiring dependencies of removed packages', async () => {
    install([
      { name: 'a', deps: ['gone'] },
      { name: 'b', deps: ['also-gone'] },
    ]);
    const graph = await graphOf(['a', 'b']);
    expect(() => assertNoMissingDependencies(graph, new Set())).not.toThrow();
    expect(() =>
      assertNoMissingDependencies(graph, new Set(['node_modules/a'])),
    ).toThrow(BundleTreeError);
    expect(() => assertNoMissingDependencies(graph)).toThrow(BundleTreeError);
  });

  it('treats an optional dependency listed twice as optional', async () => {
    install([{ name: 'a', deps: ['x'], optional: ['x'] }]);
    expect((await graphOf(['a'])).missing).toEqual([]);
  });

  describe('segmentation', () => {
    const group = (label: string, ...patterns: string[]) => ({
      label,
      patterns,
    });

    it('removes a disabled root and only its exclusive dependencies', async () => {
      install([
        { name: 'web', deps: ['kit', 'shared'] },
        { name: 'kit', deps: ['shared'] },
        { name: 'googleapis', deps: ['gaxios', 'shared'] },
        { name: 'gaxios', deps: ['gaxios-leaf'] },
        { name: 'gaxios-leaf' },
        { name: 'shared' },
      ]);
      // The app depends on googleapis directly and through nothing else.
      const graph = await graphOf(['web', 'googleapis']);
      const result = computeSegmentation(graph, [
        group('feature:google-apis', 'googleapis'),
      ]);
      expect(result.removed.map((item) => [item.name, item.reason])).toEqual([
        ['gaxios', 'exclusive-dependency-of:feature:google-apis'],
        ['gaxios-leaf', 'exclusive-dependency-of:feature:google-apis'],
        ['googleapis', 'feature:google-apis'],
      ]);
      expect([...result.keep].sort()).toEqual([
        'node_modules/kit',
        'node_modules/shared',
        'node_modules/web',
      ]);
      expect([...result.removedDirs].sort()).toEqual([
        'gaxios',
        'gaxios-leaf',
        'googleapis',
      ]);
      expect(result.orphans).toEqual([]);
      expect(result.unmatchedGroups).toEqual([]);
    });

    it('keeps a dependency that a kept package also reaches', async () => {
      install([
        { name: 'web', deps: ['a', 'big'] },
        { name: 'a', deps: ['common'] },
        { name: 'big', deps: ['common', 'only-big'] },
        { name: 'common' },
        { name: 'only-big' },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('feature:x', 'big'),
      ]);
      expect(result.removed.map((item) => item.name)).toEqual([
        'big',
        'only-big',
      ]);
    });

    it('handles cycles: a cycle behind a disabled root goes, a cycle reachable from the app stays', async () => {
      install([
        { name: 'web', deps: ['alive-1', 'dead-root'] },
        { name: 'alive-1', deps: ['alive-2'] },
        { name: 'alive-2', deps: ['alive-1'] },
        { name: 'dead-root', deps: ['dead-1'] },
        { name: 'dead-1', deps: ['dead-2'] },
        { name: 'dead-2', deps: ['dead-1', 'alive-2'] },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('exclude', 'dead-root'),
      ]);
      expect(result.removed.map((item) => item.name)).toEqual([
        'dead-1',
        'dead-2',
        'dead-root',
      ]);
      expect([...result.keep].sort()).toEqual([
        'node_modules/alive-1',
        'node_modules/alive-2',
        'node_modules/web',
      ]);
    });

    it('a cycle member reached by a kept package keeps the whole cycle', async () => {
      install([
        { name: 'web', deps: ['dead-root', 'c-1'] },
        { name: 'dead-root', deps: ['c-1'] },
        { name: 'c-1', deps: ['c-2'] },
        { name: 'c-2', deps: ['c-1'] },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('exclude', 'dead-root'),
      ]);
      expect(result.removed.map((item) => item.name)).toEqual(['dead-root']);
    });

    it('matches scope and prefix patterns and reports unmatched groups', async () => {
      install([
        {
          name: 'web',
          deps: ['@rolldown/binding-darwin', 'lightningcss-darwin'],
        },
        { name: '@rolldown/binding-darwin' },
        { name: 'lightningcss-darwin' },
        { name: 'rolldown-keep' },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('feature:toolchain', '@rolldown/*', 'lightningcss*'),
        group('feature:pdf', 'pdfjs-dist'),
      ]);
      expect(result.removed.map((item) => item.name)).toEqual([
        '@rolldown/binding-darwin',
        'lightningcss-darwin',
      ]);
      expect(result.unmatchedGroups).toEqual(['feature:pdf']);
      // Not reachable from the app at all: kept and reported.
      expect(result.orphans).toEqual(['node_modules/rolldown-keep']);
      expect(result.keep.has('node_modules/rolldown-keep')).toBe(true);
    });

    it('attributes shared subtrees to the first group in order', async () => {
      install([
        { name: 'web', deps: ['one', 'two'] },
        { name: 'one', deps: ['leaf'] },
        { name: 'two', deps: ['leaf'] },
        { name: 'leaf' },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('feature:a', 'one'),
        group('feature:b', 'two'),
      ]);
      expect(result.removed.find((item) => item.name === 'leaf')?.reason).toBe(
        'exclusive-dependency-of:feature:a',
      );
    });

    it('counts a peer dependency that is installed as an edge', async () => {
      install([
        { name: 'web', deps: ['plugin', 'host'] },
        { name: 'plugin', peer: ['framework'] },
        { name: 'host', deps: ['framework'] },
        { name: 'framework' },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('exclude', 'host'),
      ]);
      // framework stays: plugin (kept) peers on it.
      expect(result.removed.map((item) => item.name)).toEqual(['host']);
    });

    it('removes a nested package that lives inside a removed package', async () => {
      install([
        { name: 'web', deps: ['big'] },
        {
          name: 'big',
          deps: ['inner'],
          nested: [{ name: 'inner', deps: [] }],
        },
        { name: 'free-floating' },
      ]);
      const graph = await graphOf(['web']);
      const result = computeSegmentation(graph, [group('exclude', 'big')]);
      expect(result.removed.map((item) => item.dir).sort()).toEqual([
        'big',
        'big/node_modules/inner',
      ]);
      expect(result.orphans).toEqual(['node_modules/free-floating']);
    });

    it('moves an orphan nested inside a removed package into the removed set', async () => {
      install([
        { name: 'web', deps: ['big'] },
        { name: 'big', nested: [{ name: 'stray' }] },
      ]);
      const result = computeSegmentation(await graphOf(['web']), [
        group('exclude', 'big'),
      ]);
      const stray = result.removed.find((item) => item.name === 'stray');
      expect(stray?.reason).toBe('inside-removed-package');
      expect(result.keep.has('node_modules/big/node_modules/stray')).toBe(
        false,
      );
    });

    it('answers the import scan: is this specifier a removed package from here?', async () => {
      install([
        { name: 'web', deps: ['a', 'big'] },
        {
          name: 'a',
          nested: [{ name: 'big', version: '2.0.0' }],
          deps: ['big'],
        },
        { name: 'big' },
      ]);
      const graph = await graphOf(['web']);
      const seg = computeSegmentation(graph, [group('exclude', 'big')]);
      const removed = createRemovalChecker(graph, seg);
      // The nested copy inside `a` and the hoisted copy both match by name.
      expect(removed(APP_ROOT, 'big')).toBe(true);
      expect(removed('node_modules/a', 'big')).toBe(true);
      expect(removed(APP_ROOT, 'a')).toBe(false);
      expect(removed(APP_ROOT, 'not-installed')).toBe(false);
    });
  });

  it('exposes entry paths and install-script audit data', async () => {
    install([
      { name: 'web', main: './lib/index.js' },
      { name: 'native', scripts: { postinstall: 'node-gyp rebuild' } },
      { name: 'esbuild', scripts: { postinstall: 'node install.js' } },
      { name: 'quiet', scripts: { test: 'vitest' } },
    ]);
    const packages = await readInstalledPackages(modules);
    expect(entryPathsByDir(packages).get('web')).toEqual(['lib/index.js']);
    expect(packagesNeedingBuild(packages).map((pkg) => pkg.name)).toEqual([
      'native',
    ]);
    expect(
      packagesNeedingBuild(packages, new Set()).map((p) => p.name),
    ).toEqual(['esbuild', 'native']);
  });
});

describe('package patterns', () => {
  it('matches exact names and star patterns on whole names', () => {
    expect(matchPackageName('vite', 'vite')).toBe(true);
    expect(matchPackageName('vite', 'vite-plugin')).toBe(false);
    expect(matchPackageName('oxc-*', 'oxc-transform')).toBe(true);
    expect(matchPackageName('oxc-*', '@oxc-project/types')).toBe(false);
    expect(matchPackageName('@oxc-*/*', '@oxc-project/types')).toBe(true);
    expect(matchPackageName('@rolldown/*', '@rolldown/binding')).toBe(true);
    expect(matchPackageName('@rolldown/*', '@rolldown/a/b')).toBe(false);
    expect(matchPackageName('lightningcss*', 'lightningcss-darwin-arm64')).toBe(
      true,
    );
    expect(matchPackageName('a.b', 'axb')).toBe(false);
  });

  it('validates the pattern grammar', () => {
    for (const ok of ['vite', '@scope/*', 'oxc-*', '@oxc-*/*', 'a.b_c~d']) {
      expect(isPackagePattern(ok)).toBe(true);
    }
    for (const bad of [
      '',
      '../x',
      '/abs',
      'a b',
      '.hidden',
      '_x',
      'A/B',
      '*/*/*',
    ]) {
      expect(isPackagePattern(bad)).toBe(false);
    }
  });
});

describe('registry-only resolutions', () => {
  it('accepts registry specifiers', () => {
    for (const spec of [
      '^1.2.3',
      '~1.2',
      '>=1 <2',
      '1.x',
      '*',
      'latest',
      'npm:other@^1',
      'catalog:',
      '^1 || ^2',
    ]) {
      expect(isRegistrySpecifier(spec)).toBe(true);
    }
  });

  it('refuses link, file, git, workspace and URL specifiers', () => {
    for (const spec of [
      'link:../x',
      'file:../x.tgz',
      'portal:../x',
      'workspace:*',
      'git+ssh://git@example.com/x.git',
      'git://example.com/x.git',
      'github:user/repo',
      'user/repo',
      'user/repo#v1',
      'https://example.com/x.tgz',
      'http://example.com/x.tgz',
      '../x',
      './x',
      '/abs/x',
    ]) {
      expect(isRegistrySpecifier(spec)).toBe(false);
    }
  });

  const pkg = (
    name: string,
    dependencies: Record<string, string>,
  ): InstalledPackage => ({
    id: `node_modules/${name}`,
    dir: name,
    installName: name,
    name,
    version: '1.0.0',
    dependencies,
    optionalDependencies: {},
    peerDependencies: {},
    installScripts: [],
    gypfile: false,
    entryPaths: [],
  });

  it('finds them in the app and in installed packages without echoing specifiers', () => {
    const packages = [
      pkg('a', { ok: '^1', evil: 'git+ssh://u:token@h/x.git' }),
    ];
    const found = findNonRegistryDependencies(packages, { local: 'link:../l' });
    expect(found).toEqual([
      { from: APP_ROOT, name: 'local' },
      { from: 'node_modules/a', name: 'evil' },
    ]);
    const error = (() => {
      try {
        assertRegistryDependencies(packages, {});
      } catch (e) {
        return e as BundleTreeError;
      }
      return undefined;
    })();
    expect(error?.code).toBe('unsupported_resolution');
    expect(JSON.stringify(error)).not.toContain('token');
    expect(error?.subjects).toEqual(['node_modules/a -> evil']);
  });
});
