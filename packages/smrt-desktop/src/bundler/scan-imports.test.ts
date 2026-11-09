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
import { APP_ROOT } from './graph.js';
import {
  analyzeSources,
  assertNoRemovedImports,
  extractImports,
  type ImportRef,
  packageNameOf,
  scanDirectory,
} from './scan-imports.js';
import { BundleTreeError } from './tree-errors.js';

function specs(source: string): string[] {
  return extractImports(source).refs.map(
    (ref) => `${ref.kind}${ref.lazy ? '~' : ''}:${ref.specifier}`,
  );
}

describe('extractImports: literal specifiers', () => {
  it.each([
    ["import a from 'x';", ['static:x']],
    ['import {a as b} from "x";', ['static:x']],
    ["import * as ns from 'x';", ['static:x']],
    ["import d, {e} from 'x';", ['static:x']],
    ["import 'x';", ['static:x']],
    ["export * from 'x';", ['static:x']],
    ["export * as ns from 'x';", ['static:x']],
    ["export {a, b} from 'x';", ['static:x']],
    ["import {\n  a,\n  b,\n} from\n  'x';", ['static:x']],
    ['import{a}from"x";export*from"y"', ['static:x', 'static:y']],
    ["import('x');", ['dynamic~:x']],
    ["await import('x')", ['dynamic~:x']],
    ["import('x', { with: { type: 'json' } })", ['dynamic~:x']],
    ['import(`x`)', ['dynamic~:x']],
    ["const a = require('x');", ['static:x']],
    ["module.exports = require('x');", ['static:x']],
    ["require('x');", ['static:x']],
    ["require.resolve('x')", ['resolve~:x']],
    ["import.meta.resolve('x')", ['resolve~:x']],
    ["function f() { return require('x'); }", ['require~:x']],
    ["if (a) { require('x'); }", ['require~:x']],
    ["foo(require('x'))", ['require~:x']],
    ["const f = () => require('x');", ['require~:x']],
    ["lazy(() => import('x'))", ['dynamic~:x']],
    [
      "import a from 'x'; import('x'); require('x')",
      ['static:x', 'dynamic~:x'],
    ],
  ])('%j', (source, expected) => {
    expect(specs(source)).toEqual(expected);
  });

  it('reports each distinct reference once', () => {
    expect(specs("import 'x'; import 'x'; import 'x'")).toEqual(['static:x']);
  });

  it('records line numbers', () => {
    const [ref] = extractImports("\n\n// c\nimport a from 'x'").refs;
    expect(ref?.line).toBe(4);
  });

  it('classifies an arrow body as lazy only until the next statement', () => {
    const refs = extractImports(
      "const f = () => require('lazy')\nconst y = require('eager')",
    ).refs;
    expect(refs.map((r: ImportRef) => [r.specifier, r.lazy])).toEqual([
      ['lazy', true],
      ['eager', false],
    ]);
    const semi = extractImports(
      "const f = () => require('lazy');\nrequire('eager');",
    ).refs;
    expect(semi.map((r: ImportRef) => [r.specifier, r.lazy])).toEqual([
      ['lazy', true],
      ['eager', false],
    ]);
  });
});

describe('extractImports: things that are not imports', () => {
  it.each([
    ["// import 'x'", []],
    ["/* import 'x'; require('y') */", []],
    ["/* multi\nline */ // import 'z'\n", []],
    ['const s = "import \'x\'";', []],
    ['const s = \'require("x")\';', []],
    ["const s = `import 'x' and require('y')`;", []],
    ["obj.import('x');", []],
    ["obj.require('x');", []],
    ["obj?.require('x');", []],
    ["Array.from('abc');", []],
    ["x.from('y');", []],
    ['function require(name) { return name }', []],
    ['const re = /import "x"/;', []],
    ["const re = /['\"]import/; const q = 'a';", []],
    ['', []],
  ])('%j finds nothing', (source, expected) => {
    expect(specs(source)).toEqual(expected);
  });

  it('keeps brace depth right across strings, regexes and templates', () => {
    expect(specs('const s = "}"; require("x")')).toEqual(['static:x']);
    expect(specs("const s = '{'; require('x')")).toEqual(['static:x']);
    expect(specs('const r = /}/; require("x")')).toEqual(['static:x']);
    expect(specs('const r = /[}]/g; require("x")')).toEqual(['static:x']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source fixture
    expect(specs('const t = `${ {a:1}.a }`; require("x")')).toEqual([
      'static:x',
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source fixture
    expect(specs('const t = `a${`b${1}`}c`; require("x")')).toEqual([
      'static:x',
    ]);
    expect(specs('const d = a / b / c; require("x")')).toEqual(['static:x']);
    expect(specs('f({}); /* } */ require("x")')).toEqual(['static:x']);
    // ... and a `{` hidden in a string does not make later code lazy.
    expect(specs('const s = "{{{"; require("x")')).toEqual(['static:x']);
  });

  it('survives a hashbang, unterminated input and odd characters', () => {
    expect(specs("#!/usr/bin/env node\nimport 'x'")).toEqual(['static:x']);
    expect(() => extractImports("import 'x' `unterminated ${")).not.toThrow();
    expect(() => extractImports('/* never closed')).not.toThrow();
    expect(() => extractImports("'unterminated")).not.toThrow();
    expect(() => extractImports('/regex-no-close\n')).not.toThrow();
    expect(specs('﻿import "x"')).toEqual(['static:x']);
  });
});

describe('extractImports: non-literal loads', () => {
  it('reports them without guessing a specifier', () => {
    const result = extractImports(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source fixture
      'import(name); require(path); import(`./${x}.js`); import(a + b)',
    );
    expect(result.refs).toEqual([]);
    expect(result.nonLiteral.map((item) => item.via)).toEqual([
      'import',
      'require',
      'import',
      'import',
    ]);
  });

  it('does not report member calls or declarations', () => {
    expect(
      extractImports('obj.import(a); function require(a) {}').nonLiteral,
    ).toEqual([]);
  });
});

describe('packageNameOf', () => {
  it.each([
    ['x', 'x'],
    ['x/sub/path.js', 'x'],
    ['@scope/name', '@scope/name'],
    ['@scope/name/sub', '@scope/name'],
    ['./rel', undefined],
    ['../rel', undefined],
    ['/abs', undefined],
    ['#internal', undefined],
    ['node:fs', undefined],
    ['https://example.com/x.js', undefined],
    ['data:text/javascript,1', undefined],
    ['@scope', undefined],
    ['', undefined],
  ])('%j', (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });
});

describe('analyzeSources', () => {
  const removed = new Set(['sharp', '@img/sharp-darwin-arm64', 'googleapis']);
  const isRemoved = (_owner: string, name: string) => removed.has(name);
  const source = (text: string, path = 'app/build/x.js', from = path) => ({
    owner: APP_ROOT,
    path,
    from,
    text,
  });

  it('flags a static import of a removed package', () => {
    const report = analyzeSources(
      [source("import sharp from 'sharp';")],
      isRemoved,
    );
    expect(report.static).toEqual([
      {
        path: 'app/build/x.js',
        package: 'sharp',
        specifier: 'sharp',
        kind: 'static',
        line: 1,
      },
    ]);
    expect(() => assertNoRemovedImports(report)).toThrow(BundleTreeError);
  });

  it('flags a top-level require and a sub-path import', () => {
    const report = analyzeSources(
      [source("const g = require('googleapis/build/src/x');")],
      isRemoved,
    );
    expect(report.static).toMatchObject([
      { package: 'googleapis', specifier: 'googleapis/build/src/x' },
    ]);
  });

  it('ignores kept packages, builtins and relative specifiers', () => {
    const report = analyzeSources(
      [
        source(
          "import fs from 'node:fs'; import a from './a.js'; import k from 'kept'; import('kept2')",
        ),
      ],
      isRemoved,
    );
    expect(report.static).toEqual([]);
    expect(report.dynamic).toEqual([]);
    expect(() => assertNoRemovedImports(report)).not.toThrow();
  });

  it('requires acknowledgement for a lazy load of a removed package', () => {
    const text = "export const load = () => import('sharp');";
    const report = analyzeSources([source(text)], isRemoved);
    expect(report.dynamic).toHaveLength(1);
    expect(report.acknowledged).toHaveLength(0);
    try {
      assertNoRemovedImports(report);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BundleTreeError);
      expect((error as BundleTreeError).code).toBe(
        'dynamic_import_unacknowledged',
      );
      expect((error as BundleTreeError).subjects).toEqual([
        'app/build/x.js -> sharp',
      ]);
    }
  });

  it('accepts an acknowledged lazy load and records it', () => {
    const text = "export const load = () => import('sharp');";
    for (const ack of [
      { from: 'app/build/x.js', specifier: 'sharp' },
      { from: 'app/build', specifier: 'sharp' },
      { from: 'app/build/x.js', specifier: 'sharp' },
    ]) {
      const report = analyzeSources([source(text)], isRemoved, [ack]);
      expect(report.dynamic).toEqual([]);
      expect(report.acknowledged).toHaveLength(1);
      expect(() => assertNoRemovedImports(report)).not.toThrow();
    }
  });

  it('matches acknowledgements by file and specifier, never loosely', () => {
    const text = "export const load = () => import('sharp');";
    for (const ack of [
      { from: 'app/build/other.js', specifier: 'sharp' },
      { from: 'app/buil', specifier: 'sharp' },
      { from: 'app/build/x.js', specifier: 'googleapis' },
    ]) {
      const report = analyzeSources([source(text)], isRemoved, [ack]);
      expect(report.dynamic).toHaveLength(1);
    }
  });

  it('never lets an acknowledgement excuse a static import', () => {
    const report = analyzeSources([source("import 'sharp';")], isRemoved, [
      { from: 'app/build/x.js', specifier: 'sharp' },
    ]);
    expect(report.static).toHaveLength(1);
    expect(() => assertNoRemovedImports(report)).toThrow(
      expect.objectContaining({ code: 'removed_package_imported' }),
    );
  });

  it('reports a static failure before an unacknowledged lazy one', () => {
    const report = analyzeSources(
      [source("import 'sharp'; import('googleapis');")],
      isRemoved,
    );
    expect(() => assertNoRemovedImports(report)).toThrow(
      expect.objectContaining({ code: 'removed_package_imported' }),
    );
  });

  it('lists non-literal loads without failing', () => {
    const report = analyzeSources(
      [source('const m = await import(name);')],
      isRemoved,
    );
    expect(report.nonLiteral).toEqual([
      { path: 'app/build/x.js', via: 'import', line: 1 },
    ]);
    expect(() => assertNoRemovedImports(report)).not.toThrow();
  });

  it('resolves per owner: the same specifier can be kept for one file and removed for another', () => {
    const perOwner = (owner: string, name: string) =>
      owner === 'node_modules/a' && name === 'dep';
    const report = analyzeSources(
      [
        {
          owner: 'node_modules/a',
          path: 'a.js',
          from: 'a',
          text: "import 'dep'",
        },
        {
          owner: 'node_modules/b',
          path: 'b.js',
          from: 'b',
          text: "import 'dep'",
        },
      ],
      perOwner,
    );
    expect(report.static.map((f) => f.path)).toEqual(['a.js']);
  });

  it('error output never contains source text', () => {
    const report = analyzeSources(
      [source("import 'sharp'; const SECRET_TOKEN_VALUE = 1;")],
      isRemoved,
    );
    try {
      assertNoRemovedImports(report);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('SECRET_TOKEN_VALUE');
    }
  });
});

describe('scanDirectory', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-scan-')));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (rel: string, content: string) => {
    const path = join(base, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  const removedSharp = (_owner: string, name: string) => name === 'sharp';

  it('scans an application build tree', async () => {
    put('index.js', "import './chunks/a.js';");
    put('chunks/a.js', "import sharp from 'sharp';");
    put('chunks/b.mjs', "export const f = () => import('sharp');");
    put('chunks/c.cjs', "module.exports = require('sharp');");
    put('chunks/readme.md', "import 'sharp'");
    put('chunks/data.json', '{"sharp":1}');
    const report = await scanDirectory({
      root: base,
      kind: 'app-build',
      isRemoved: removedSharp,
    });
    expect(report.filesScanned).toBe(4);
    expect(report.static.map((f) => f.path).sort()).toEqual([
      'app/build/chunks/a.js',
      'app/build/chunks/c.cjs',
    ]);
    expect(report.dynamic.map((f) => f.path)).toEqual([
      'app/build/chunks/b.mjs',
    ]);
  });

  it('scans node_modules with per-package owners and acknowledgements by package name', async () => {
    put('ws/package.json', '{}');
    put(
      'ws/lib/buffer-util.js',
      "try { require('bufferutil') } catch (e) { module.exports = {} }",
    );
    put('a/node_modules/b/index.js', "import('sharp')");
    put('@s/p/index.js', "import 'sharp'");
    const owners: string[] = [];
    const report = await scanDirectory({
      root: base,
      kind: 'node-modules',
      isRemoved: (owner, name) => {
        owners.push(owner);
        return name === 'bufferutil' || name === 'sharp';
      },
      acknowledged: [
        { from: 'ws', specifier: 'bufferutil' },
        { from: 'b', specifier: 'sharp' },
      ],
    });
    expect(report.acknowledged.map((f) => f.path).sort()).toEqual([
      'node_modules/a/node_modules/b/index.js',
      'node_modules/ws/lib/buffer-util.js',
    ]);
    expect(report.static.map((f) => f.path)).toEqual([
      'node_modules/@s/p/index.js',
    ]);
    expect(new Set(owners)).toEqual(
      new Set([
        'node_modules/ws',
        'node_modules/a/node_modules/b',
        'node_modules/@s/p',
      ]),
    );
  });

  it('lists oversized files as unscanned instead of failing', async () => {
    put('big.js', `import 'sharp';${' '.repeat(200)}`);
    put('small.js', "import 'other';");
    const report = await scanDirectory({
      root: base,
      kind: 'app-build',
      isRemoved: removedSharp,
      maxFileBytes: 100,
    });
    expect(report.unscanned).toEqual(['big.js']);
    expect(report.filesScanned).toBe(1);
  });

  it('refuses a symlinked script rather than reading through it', async () => {
    put('real.js', 'export {}');
    symlinkSync(join(base, 'real.js'), join(base, 'link.js'));
    await expect(
      scanDirectory({ root: base, kind: 'app-build', isRemoved: removedSharp }),
    ).rejects.toMatchObject({ code: 'symlink_refused' });
  });
});
