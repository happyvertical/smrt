import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDependencyGraph,
  computeSegmentation,
  readInstalledPackages,
} from './graph.js';
import {
  assertNoMissingRelativeImports,
  extractAssetRefs,
  isAssetDirectoryRef,
  resolvePackageEntry,
  scanReachable,
} from './reach.js';
import { assertNoRemovedImports } from './scan-imports.js';
import { BundleTreeError } from './tree-errors.js';

let root: string;
let build: string;
let modules: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-reach-')));
  build = join(root, 'build');
  modules = join(root, 'node_modules');
  mkdirSync(build, { recursive: true });
  mkdirSync(modules, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function pkg(
  name: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
  nestedIn?: string,
): void {
  const dir =
    nestedIn === undefined
      ? join(modules, name)
      : join(modules, nestedIn, 'node_modules', name);
  put(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  );
  for (const [rel, text] of Object.entries(files)) put(join(dir, rel), text);
}

async function scan(
  rootDeps: string[],
  removedNames: string[],
  options: { acknowledged?: { from: string; specifier: string }[] } = {},
  entryText = "import 'a';\n",
) {
  put(join(build, 'index.js'), entryText);
  const packages = await readInstalledPackages(modules);
  const graph = buildDependencyGraph(packages, rootDeps);
  const segmentation = computeSegmentation(graph, [
    { label: 'test', patterns: removedNames },
  ]);
  return scanReachable({
    buildRoot: build,
    modulesRoot: modules,
    entry: join(build, 'index.js'),
    graph,
    keep: segmentation.keep,
    ...options,
  });
}

describe('load-time reachability', () => {
  it('reports a removed package imported at load time through kept packages', async () => {
    pkg('a', { 'index.js': "import 'b';\n" }, { dependencies: { b: '1' } });
    pkg(
      'b',
      { 'index.js': "import 'gone';\n" },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static).toEqual([
      {
        path: 'node_modules/b/index.js',
        package: 'gone',
        specifier: 'gone',
        kind: 'static',
        line: 1,
      },
    ]);
    expect(() => assertNoRemovedImports(report)).toThrow(BundleTreeError);
  });

  it('ignores a build-time file of a kept package that nothing loads', async () => {
    // The @sveltejs/kit case: its Vite plugin imports vite, the sidecar never loads it.
    pkg(
      'a',
      {
        'index.js': 'export default 1;\n',
        'src/vite/plugin.js': "import 'vite';\n",
      },
      { dependencies: { vite: '1' }, exports: { '.': './index.js' } },
    );
    pkg('vite', { 'index.js': '' });
    const report = await scan(['a'], ['vite']);
    expect(report.static).toEqual([]);
    expect(report.dynamic).toEqual([]);
    expect(report.staticFiles).toBe(2); // entry + a/index.js
  });

  it('treats a top-level require of a removed package as load-time', async () => {
    pkg(
      'a',
      { 'index.js': "const x = require('gone');\n" },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static.map((f) => f.package)).toEqual(['gone']);
  });

  it('follows relative imports with extension and index probing', async () => {
    pkg(
      'a',
      {
        'index.js': "import './lib/util';\nimport './dir';\n",
        'lib/util.js': "import 'gone';\n",
        'dir/index.js': "import './deep.mjs';\n",
        'dir/deep.mjs': "import 'gone2';\n",
      },
      { dependencies: { gone: '1', gone2: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    pkg('gone2', { 'index.js': '' });
    const report = await scan(['a'], ['gone', 'gone2']);
    expect(report.static.map((f) => f.path).sort()).toEqual([
      'node_modules/a/dir/deep.mjs',
      'node_modules/a/lib/util.js',
    ]);
  });

  it('ignores relative paths that leave the bundle', async () => {
    const report = await scan(
      [],
      [],
      {},
      "import '../../../etc/passwd.js';\nimport '/etc/passwd.js';\n",
    );
    expect(report.static).toEqual([]);
    expect(report.filesScanned).toBe(1);
  });

  it('terminates on import cycles', async () => {
    pkg(
      'a',
      {
        'index.js': "import './b.js';\n",
        'b.js': "import './index.js';\nimport 'gone';\n",
      },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static).toHaveLength(1);
    expect(report.filesScanned).toBe(3);
  });
});

describe('lazy reachability', () => {
  it('needs an acknowledgement for a lazy import of a removed package', async () => {
    pkg(
      'a',
      { 'index.js': "export const load = () => import('gone');\n" },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static).toEqual([]);
    expect(report.dynamic.map((f) => [f.path, f.package])).toEqual([
      ['node_modules/a/index.js', 'gone'],
    ]);
    expect(() => assertNoRemovedImports(report)).toThrow(BundleTreeError);

    const acknowledged = await scan(['a'], ['gone'], {
      acknowledged: [{ from: 'a', specifier: 'gone' }],
    });
    expect(acknowledged.dynamic).toEqual([]);
    expect(acknowledged.acknowledged).toHaveLength(1);
    expect(() => assertNoRemovedImports(acknowledged)).not.toThrow();
  });

  it('demotes a static import found only in a lazily loaded file', async () => {
    pkg(
      'a',
      {
        'index.js': "export const route = () => import('./route.js');\n",
        'route.js': "import 'gone';\n",
      },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static).toEqual([]);
    expect(report.dynamic.map((f) => f.path)).toEqual([
      'node_modules/a/route.js',
    ]);
    expect(report.staticFiles).toBe(2);
    expect(report.lazyFiles).toBe(1);
  });

  it('promotes a file to load-time when any load-time edge reaches it', async () => {
    pkg(
      'a',
      {
        'index.js':
          "import './shared.js';\nexport const l = () => import('./shared.js');\n",
        'shared.js': "import 'gone';\n",
      },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static.map((f) => f.path)).toEqual([
      'node_modules/a/shared.js',
    ]);
  });

  it('matches an acknowledgement for the application build by path prefix', async () => {
    pkg('gone', { 'index.js': '' });
    const entry = "export const l = () => import('gone');\n";
    const report = await scan([], ['gone'], {}, entry);
    expect(report.dynamic.map((f) => f.path)).toEqual(['app/build/index.js']);
    const acknowledged = await scan(
      [],
      ['gone'],
      { acknowledged: [{ from: 'app/build', specifier: 'gone' }] },
      entry,
    );
    expect(acknowledged.acknowledged).toHaveLength(1);
  });
});

describe('relative imports whose target is missing', () => {
  it('reports a load-time import of a file that is not in the tree, and fails on it', async () => {
    pkg('a', { 'index.js': "import './lib/helper.js';\n" });
    const report = await scan(['a'], []);
    expect(report.relativeMissing).toEqual([
      {
        path: 'node_modules/a/index.js',
        package: './lib/helper.js',
        specifier: './lib/helper.js',
        kind: 'static',
        line: 1,
      },
    ]);
    expect(() => assertNoMissingRelativeImports(report)).toThrow(
      expect.objectContaining({
        code: 'relative_import_missing',
        subjects: ['node_modules/a/index.js -> ./lib/helper.js'],
      }),
    );
    expect(() => assertNoMissingRelativeImports(report)).toThrow(
      BundleTreeError,
    );
  });

  it('reports the build output too, and lazy imports as dynamic', async () => {
    pkg('a', {
      'index.js': "export const load = () => import('./gone.js');\n",
    });
    const report = await scan(
      ['a'],
      [],
      {},
      "import 'a';\nimport './missing-chunk.js';\n",
    );
    expect(
      report.relativeMissing.map((f) => [f.path, f.specifier, f.kind]),
    ).toEqual([
      ['app/build/index.js', './missing-chunk.js', 'static'],
      ['node_modules/a/index.js', './gone.js', 'dynamic'],
    ]);
  });

  it('lets the product acknowledge a missing relative import, and records it', async () => {
    pkg('a', {
      'index.js': "try { await import('./optional.js'); } catch {}\n",
    });
    const report = await scan(['a'], [], {
      acknowledged: [{ from: 'a', specifier: './optional.js' }],
    });
    expect(report.relativeMissing).toEqual([]);
    expect(report.acknowledged.map((f) => f.specifier)).toEqual([
      './optional.js',
    ]);
    expect(() => assertNoMissingRelativeImports(report)).not.toThrow();
  });

  it('accepts targets that exist: scripts, json, wasm, directories and extensionless probes', async () => {
    pkg('a', {
      'index.js':
        "import './data.json' with { type: 'json' };\nimport './x.wasm';\nimport './dir';\nimport './lib/util';\n",
      'data.json': '{}',
      'x.wasm': '',
      'dir/index.js': '',
      'lib/util.js': '',
    });
    const report = await scan(['a'], []);
    expect(report.relativeMissing).toEqual([]);
  });

  it('leaves a missing .node addon to the native verification stage', async () => {
    pkg('a', {
      'index.js': "import './build/Release/a.node';\nimport './q.js?raw';\n",
    });
    const report = await scan(['a'], []);
    expect(report.relativeMissing).toEqual([]);
  });

  it('keeps a bare import that resolves to nothing as a count, not a failure', async () => {
    pkg('a', { 'index.js': "import 'not-installed';\n" });
    const report = await scan(['a'], []);
    expect(report.unresolved).toBe(1);
    expect(report.relativeMissing).toEqual([]);
  });
});

describe('files a reached module refers to', () => {
  it('returns relative import targets of any kind, and literal asset paths, as protected', async () => {
    pkg('a', {
      'index.js': [
        "import './test/setup.js';",
        "import data from './notes.json' with { type: 'json' };",
        "const html = readFileSync(new URL('./views/page.html', import.meta.url));",
        "const css = readFileSync(join(__dirname, 'assets', 'site.css'));",
        '',
      ].join('\n'),
      'test/setup.js': 'export {};\n',
      'notes.json': '{}',
      'views/page.html': '<p>',
      'assets/site.css': 'a{}',
      'unrelated/README.md': '#',
    });
    const report = await scan(['a'], []);
    const rel = report.protectedPaths.map((path) =>
      path.slice(modules.length + 1),
    );
    expect(rel).toEqual([
      'a/assets/site.css',
      'a/notes.json',
      'a/test/setup.js',
      'a/views/page.html',
    ]);
  });

  it('protects a directory a module names, but only an explicit asset directory with its contents', async () => {
    pkg('a', {
      'index.js': [
        "const root = path.resolve(__dirname, '..');",
        "const here = new URL('./', import.meta.url);",
        "const all = readdirSync('./');",
        "const assets = new URL('./static/', import.meta.url);",
        '',
      ].join('\n'),
      'static/a.txt': 'a',
      'test/fixtures/key.pem': 'k',
    });
    const report = await scan(['a'], []);
    const rel = (paths: readonly string[]) =>
      paths.map((path) => path.slice(modules.length + 1));
    expect(rel(report.protectedPaths)).toContain('a/static');
    expect(rel(report.protectedSubtrees)).toEqual(['a/static']);
  });

  it('classifies a trailing-slash literal as an asset directory only when it names one', () => {
    for (const asset of ['./assets/', './a/b/', '../data/']) {
      expect(isAssetDirectoryRef(asset), asset).toBe(true);
    }
    for (const other of [
      './',
      '../',
      './..',
      '../../',
      './a',
      './a.txt',
      '.',
    ]) {
      expect(isAssetDirectoryRef(other), other).toBe(false);
    }
  });

  it('does not protect what only an unreached file refers to', async () => {
    pkg('a', {
      'index.js': 'export {};\n',
      'build-only.js': "import './helper.json' with { type: 'json' };\n",
      'helper.json': '{}',
    });
    const report = await scan(['a'], []);
    expect(report.protectedPaths).toEqual([]);
  });

  it('extracts only literal module-relative asset paths', () => {
    expect(
      extractAssetRefs(
        [
          "new URL('./a.txt', import.meta.url);",
          'new URL(`./b-$' + '{x}.txt`, import.meta.url);',
          "new URL('https://example.com/x', import.meta.url);",
          "path.join(__dirname, '..', 'data', 'c.json');",
          "resolve(import.meta.dirname, 'd.bin');",
          'join(__dirname, name);',
          "readFileSync('./e.txt');",
          "readFileSync(someVar, 'utf8');",
        ].join('\n'),
      ),
    ).toEqual(['./../data/c.json', './a.txt', './d.bin', './e.txt']);
  });
});

describe('package resolution', () => {
  it('uses export conditions, subpath exports and patterns', async () => {
    pkg(
      'a',
      {
        'index.js': "import 'b/feature';\nimport 'b/utils/x';\n",
      },
      { dependencies: { b: '1' } },
    );
    pkg(
      'b',
      {
        'esm/main.js': '',
        'cjs/main.cjs': "import 'gone-cjs';\n",
        'feature.js': "import 'gone-feature';\n",
        'lib/x.js': "import 'gone-pattern';\n",
        'unused.js': "import 'gone-unused';\n",
      },
      {
        dependencies: {
          'gone-cjs': '1',
          'gone-feature': '1',
          'gone-pattern': '1',
          'gone-unused': '1',
        },
        exports: {
          '.': { import: './esm/main.js', require: './cjs/main.cjs' },
          './feature': './feature.js',
          './utils/*': './lib/*.js',
        },
      },
    );
    for (const name of [
      'gone-cjs',
      'gone-feature',
      'gone-pattern',
      'gone-unused',
    ]) {
      pkg(name, { 'index.js': '' });
    }
    const report = await scan(
      ['a'],
      ['gone-cjs', 'gone-feature', 'gone-pattern', 'gone-unused'],
    );
    expect(report.static.map((f) => f.package).sort()).toEqual([
      'gone-feature',
      'gone-pattern',
    ]);
  });

  it('does not reach files an exports map does not expose', async () => {
    pkg(
      'a',
      { 'index.js': "import 'b/internal';\n" },
      { dependencies: { b: '1' } },
    );
    pkg(
      'b',
      { 'index.js': '', 'internal.js': "import 'gone';\n" },
      { dependencies: { gone: '1' }, exports: { '.': './index.js' } },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static).toEqual([]);
    expect(report.unresolved).toBe(1);
  });

  it('falls back to main and deep paths without an exports map', async () => {
    pkg(
      'a',
      { 'index.js': "import 'b';\nimport 'b/lib/deep.js';\n" },
      { dependencies: { b: '1' } },
    );
    pkg(
      'b',
      {
        'dist/entry.js': "import 'gone-main';\n",
        'lib/deep.js': "import 'gone-deep';\n",
      },
      {
        main: 'dist/entry.js',
        dependencies: { 'gone-main': '1', 'gone-deep': '1' },
      },
    );
    pkg('gone-main', { 'index.js': '' });
    pkg('gone-deep', { 'index.js': '' });
    const report = await scan(['a'], ['gone-main', 'gone-deep']);
    expect(report.static.map((f) => f.package).sort()).toEqual([
      'gone-deep',
      'gone-main',
    ]);
  });

  it('follows #imports of the importing package', async () => {
    pkg(
      'a',
      {
        'index.js': "import '#internal';\n",
        'src/internal.js': "import 'gone';\n",
      },
      {
        dependencies: { gone: '1' },
        imports: { '#internal': './src/internal.js' },
      },
    );
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    expect(report.static.map((f) => f.path)).toEqual([
      'node_modules/a/src/internal.js',
    ]);
  });

  it('resolves nested duplicates from the importing package', async () => {
    pkg('a', { 'index.js': "import 'dup';\n" }, { dependencies: { dup: '2' } });
    pkg('dup', { 'index.js': "import 'gone';\n" }, { version: '1' } as never);
    pkg('dup', { 'index.js': '' }, { version: '2' }, 'a');
    pkg('gone', { 'index.js': '' });
    const report = await scan(['a'], ['gone']);
    // a loads its own nested dup@2, which imports nothing removed.
    expect(report.static).toEqual([]);
  });

  it('counts an uninstalled optional dependency without failing', async () => {
    pkg('a', { 'index.js': "import 'not-installed';\n" });
    const report = await scan(['a'], []);
    expect(report.unresolved).toBe(1);
    expect(report.static).toEqual([]);
  });

  it('lists non-literal imports and unreadable files', async () => {
    pkg('a', { 'index.js': 'const n = "x"; import(n);\n' });
    const report = await scan(['a'], []);
    expect(report.nonLiteral.map((n) => n.path)).toEqual([
      'node_modules/a/index.js',
    ]);
    const big = await scan(['a'], []);
    expect(big.unscanned).toEqual([]);
  });

  it('skips files above the size cap and lists them', async () => {
    pkg(
      'a',
      { 'index.js': `import 'gone';\n${'//x\n'.repeat(1000)}` },
      { dependencies: { gone: '1' } },
    );
    pkg('gone', { 'index.js': '' });
    put(join(build, 'index.js'), "import 'a';\n");
    const packages = await readInstalledPackages(modules);
    const graph = buildDependencyGraph(packages, ['a']);
    const segmentation = computeSegmentation(graph, [
      { label: 't', patterns: ['gone'] },
    ]);
    const report = await scanReachable({
      buildRoot: build,
      modulesRoot: modules,
      entry: join(build, 'index.js'),
      graph,
      keep: segmentation.keep,
      maxFileBytes: 100,
    });
    expect(report.unscanned).toEqual(['node_modules/a/index.js']);
    expect(report.static).toEqual([]);
  });
});

describe('resolvePackageEntry', () => {
  const imp = new Set(['node', 'import', 'default']);
  it('applies sugar, arrays, nested conditions and null', () => {
    expect(resolvePackageEntry({ exports: './x.js' }, '.', imp)).toBe('./x.js');
    expect(
      resolvePackageEntry(
        { exports: { import: './i.js', default: './d.js' } },
        '.',
        imp,
      ),
    ).toBe('./i.js');
    expect(
      resolvePackageEntry(
        { exports: { '.': [{ browser: './b.js' }, './fallback.js'] } },
        '.',
        imp,
      ),
    ).toBe('./fallback.js');
    expect(
      resolvePackageEntry(
        { exports: { '.': { node: { import: './n.js' } } } },
        '.',
        imp,
      ),
    ).toBe('./n.js');
    expect(
      resolvePackageEntry({ exports: { './a': null } }, './a', imp),
    ).toBeUndefined();
    expect(
      resolvePackageEntry({ exports: { '.': './x.js' } }, './missing', imp),
    ).toBeUndefined();
  });

  it('prefers the longest matching pattern', () => {
    const manifest = {
      exports: { './*': './generic/*.js', './feat/*': './specific/*.js' },
    };
    expect(resolvePackageEntry(manifest, './feat/a', imp)).toBe(
      './specific/a.js',
    );
    expect(resolvePackageEntry(manifest, './other', imp)).toBe(
      './generic/other.js',
    );
  });

  it('defaults to main or index.js without exports', () => {
    expect(resolvePackageEntry({ main: 'lib/m.js' }, '.', imp)).toBe(
      './lib/m.js',
    );
    expect(resolvePackageEntry({}, '.', imp)).toBe('./index.js');
    expect(resolvePackageEntry({}, './sub.js', imp)).toBe('./sub.js');
  });
});
