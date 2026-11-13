/**
 * The root entry is browser-safe: its import graph reaches no `node:` built-in,
 * not the sql root (drivers), and not the Node-only `/testing` entry. Checked by
 * walking the source graph and by bundling it for a browser.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of withoutComments(source).matchAll(pattern)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

function walk(entry: string) {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(
          path.resolve(path.dirname(file), specifier).replace(/\.js$/, '.ts'),
        );
      } else bare.add(specifier);
    }
  }
  return { files, bare };
}

describe('root entry browser safety', () => {
  const graph = walk(path.join(src, 'index.ts'));

  it('imports only the spreadsheets package and the sql query subpath', () => {
    expect([...graph.bare].sort()).toEqual([
      '@happyvertical/spreadsheets',
      '@happyvertical/sql/query',
    ]);
    expect([...graph.bare].filter((s) => s.startsWith('node:'))).toEqual([]);
  });

  it('never reaches the Node-only testing entry', () => {
    expect([...graph.files].map((f) => path.basename(f))).not.toContain(
      'testing.ts',
    );
  });

  it('touches no Node global', () => {
    for (const file of graph.files) {
      expect(
        withoutComments(readFileSync(file, 'utf8')),
        path.relative(src, file),
      ).not.toMatch(/\bprocess\.|\brequire\(|__dirname|__filename|\bBuffer\b/);
    }
  });

  it('bundles for a browser with no Node built-in and no sql root', async () => {
    const result = await build({
      root: path.resolve(src, '..'),
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(src, 'index.ts'),
          formats: ['es'],
          fileName: 'out',
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (item) => ('output' in item ? item.output : []),
    );
    const chunks = outputs.filter((item) => item.type === 'chunk');
    const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules));
    const code = chunks.map((chunk) => chunk.code).join('\n');
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((id) => id.includes('browser-external'))).toEqual([]);
    expect(code).not.toMatch(/node:[a-z_/]+/);
    expect(
      modules.filter((id) =>
        /sql\/dist\/(index|sqlite|postgres|duckdb)/.test(id),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(/@libsql|better-sqlite3|from\s*["']pg["']/);
  });

  it('keeps the testing entry out of the root export map', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(src, '../package.json'), 'utf8'),
    );
    expect(Object.keys(pkg.exports)).toEqual(['.', './testing']);
    expect(pkg.exports['.'].import).toBe('./dist/index.js');
  });
});
