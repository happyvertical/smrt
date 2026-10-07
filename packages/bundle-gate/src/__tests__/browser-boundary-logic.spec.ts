import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attributeFindings,
  collectForbiddenFindings,
  discoverModelPackages,
  evaluateRatchet,
  type Finding,
  type ForbiddenFinding,
  findImportChain,
  formatOwned,
  type ImportGraph,
  type ModelPackage,
  matchForbiddenModule,
  resolveExportTarget,
} from '../browser-gate/boundary.js';
import { EXPECTED_BROWSER_FAILURES } from '../browser-gate/expected-failures.js';

describe('matchForbiddenModule', () => {
  it('flags node: built-ins, bare built-ins and subpaths', () => {
    expect(matchForbiddenModule('node:fs')).toBe('node:fs');
    expect(matchForbiddenModule('worker_threads')).toBe('node:worker_threads');
    expect(matchForbiddenModule('fs/promises')).toBe('node:fs/promises');
  });

  it('flags the named Node-only list and its subpaths', () => {
    for (const id of ['pg', 'pg-pool', 'express', 'cosmiconfig', 'jiti']) {
      expect(matchForbiddenModule(id)).toBe(id);
    }
    expect(matchForbiddenModule('better-sqlite3/lib/x')).toBe('better-sqlite3');
    expect(matchForbiddenModule('./addon/skia.darwin-arm64.node')).toBe(
      './addon/skia.darwin-arm64.node',
    );
  });

  it('does not flag browser-safe modules or userland look-alikes', () => {
    for (const id of [
      '@happyvertical/sql/pglite',
      './local.js',
      '/abs/path/fs.js',
      'punycode/',
      'string_decoder/',
      'pgvector',
      'express-like',
    ]) {
      expect(matchForbiddenModule(id)).toBeUndefined();
    }
  });
});

describe('findImportChain', () => {
  const graph: ImportGraph = new Map([
    ['entry', ['a', 'b']],
    ['a', ['c']],
    ['b', ['c', 'node:fs']],
    ['c', ['d']],
    ['d', ['node:fs']],
  ]);

  it('returns the shortest importer chain', () => {
    expect(findImportChain(graph, 'entry', 'node:fs')).toEqual([
      'entry',
      'b',
      'node:fs',
    ]);
  });

  it('returns undefined when unreachable and handles cycles', () => {
    const cyclic: ImportGraph = new Map([
      ['entry', ['a']],
      ['a', ['entry']],
    ]);
    expect(findImportChain(cyclic, 'entry', 'node:fs')).toBeUndefined();
  });

  it('builds findings that carry the chain', () => {
    const [finding] = collectForbiddenFindings(graph, 'entry', ['node:fs']);
    expect(finding).toMatchObject({
      kind: 'forbidden',
      module: 'node:fs',
      chain: ['entry', 'b', 'node:fs'],
    });
  });
});

describe('resolveExportTarget', () => {
  it('prefers the browser condition and skips types', () => {
    expect(
      resolveExportTarget({
        types: './t.d.ts',
        browser: './browser.js',
        import: './index.js',
        default: './index.js',
      }),
    ).toBe('./browser.js');
  });

  it('falls back through import/svelte/default', () => {
    expect(resolveExportTarget({ types: './t.d.ts', svelte: './s.js' })).toBe(
      './s.js',
    );
    expect(resolveExportTarget({ node: './n.js', default: './d.js' })).toBe(
      './d.js',
    );
  });
});

describe('evaluateRatchet', () => {
  const expected = { a: { issue: '#1', reason: 'x' } };

  it('passes when failures equal the expected list', () => {
    expect(evaluateRatchet(new Set(['a']), ['a', 'b'], expected).ok).toBe(true);
  });

  it('reports unexpected breakage', () => {
    const r = evaluateRatchet(new Set(['a', 'b']), ['a', 'b'], expected);
    expect(r.unexpected).toEqual(['b']);
    expect(r.ok).toBe(false);
  });

  it('reports stale entries when a listed package passes', () => {
    const r = evaluateRatchet(new Set(), ['a', 'b'], expected);
    expect(r.stale).toEqual(['a']);
    expect(r.ok).toBe(false);
  });

  it('reports entries that are not gated packages', () => {
    const r = evaluateRatchet(new Set(), ['b'], expected);
    expect(r.unknown).toEqual(['a']);
    expect(r.ok).toBe(false);
  });
});

describe('attributeFindings', () => {
  const pkg = (name: string): ModelPackage => ({
    name,
    dir: `/ws/packages/${name}`,
    entry: `/ws/packages/${name}/dist/index.js`,
  });
  const core = pkg('core');
  const app = pkg('app');
  const forbidden = (chain: string[], module: string): ForbiddenFinding => ({
    kind: 'forbidden',
    module,
    chain: [...chain, module],
  });

  it('assigns an edge reached through a dependency to that dependency', () => {
    const edge = [
      '/ws/packages/core/dist/index.js',
      '/ws/packages/core/dist/fs.js',
    ];
    const raw = new Map<string, Finding[]>([
      ['core', [forbidden(edge, 'node:fs')]],
      [
        'app',
        [forbidden(['/ws/packages/app/dist/index.js', ...edge], 'node:fs')],
      ],
    ]);
    const owned = attributeFindings([core, app], raw);
    expect(owned.get('core')).toHaveLength(1);
    expect(owned.get('app')).toHaveLength(0);
  });

  it('keeps an edge the dependency root does not reach (subpath import)', () => {
    const raw = new Map<string, Finding[]>([
      ['core', []],
      [
        'app',
        [
          forbidden(
            [
              '/ws/packages/app/dist/index.js',
              '/ws/packages/core/dist/migrations.js',
            ],
            'node:os',
          ),
        ],
      ],
    ]);
    const owned = attributeFindings([core, app], raw);
    expect(owned.get('app')).toHaveLength(1);
  });

  it('assigns a missing export to the package whose entry lacks it', () => {
    const raw = new Map<string, Finding[]>([
      [
        'app',
        [
          {
            kind: 'missing-export',
            name: 'field',
            exporter: core.entry,
            importer: '/ws/packages/app/dist/index.js',
          },
        ],
      ],
    ]);
    const owned = attributeFindings([core, app], raw);
    expect(owned.get('core')).toHaveLength(1);
    expect(owned.get('app')).toHaveLength(0);
  });

  it('assigns a missing server-only API to the importing package', () => {
    const raw = new Map<string, Finding[]>([
      [
        'app',
        [
          {
            kind: 'missing-export',
            name: 'startRestServer',
            exporter: core.entry,
            importer: '/ws/packages/app/dist/index.js',
          },
        ],
      ],
    ]);
    const owned = attributeFindings([core, app], raw);
    expect(owned.get('app')).toHaveLength(1);
    expect(owned.get('core')).toHaveLength(0);
  });

  it('formats chains with shortened ids and a module summary', () => {
    const text = formatOwned(
      [
        {
          owner: 'app',
          finding: forbidden(
            [
              '/ws/packages/app/dist/index.js',
              '/ws/node_modules/.pnpm/x/node_modules/dep/index.js',
            ],
            'pg',
          ),
        },
      ],
      '/ws',
    );
    expect(text).toContain('1 forbidden modules: pg');
    expect(text).toContain('packages/app/dist/index.js');
    expect(text).toContain('-> dep/index.js');
    expect(text).toContain('-> pg');
  });
});

describe('discoverModelPackages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'smrt-gate-discover-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const add = (
    dir: string,
    manifest: Record<string, unknown>,
    src?: string,
  ) => {
    const d = path.join(root, 'packages', dir);
    mkdirSync(path.join(d, 'src'), { recursive: true });
    writeFileSync(path.join(d, 'package.json'), JSON.stringify(manifest));
    if (src) writeFileSync(path.join(d, 'src', 'model.ts'), src);
  };

  it('derives model packages from decorators and honours exclusions', () => {
    const exportsMap = {
      '.': { browser: './dist/b.js', default: './dist/i.js' },
    };
    add('model', { name: 'm', exports: exportsMap }, '@smrt()\nclass A {}');
    add('plain', { name: 'p', exports: exportsMap }, 'export const x = 1');
    add(
      'doc-only',
      { name: 'd', exports: exportsMap },
      '/**\n * @smrt() in a comment\n */',
    );
    add(
      'priv',
      { name: 'pr', private: true, exports: exportsMap },
      '@smrt()\nclass B {}',
    );
    add('core', { name: '@happyvertical/smrt-core', exports: exportsMap });
    add(
      'cli',
      { name: '@happyvertical/smrt-cli', exports: exportsMap },
      '@smrt()\n',
    );
    const found = discoverModelPackages(root);
    expect(found.map((p) => p.name).sort()).toEqual([
      '@happyvertical/smrt-core',
      'm',
    ]);
    expect(found.find((p) => p.name === 'm')?.entry).toBe(
      path.join(root, 'packages', 'model', 'dist', 'b.js'),
    );
  });
});

describe('expected-failures list', () => {
  it('ties every entry to an issue and a reason', () => {
    for (const [name, entry] of Object.entries(EXPECTED_BROWSER_FAILURES)) {
      expect(entry.issue, name).toMatch(/^#\d+(, #\d+)*$/);
      expect(entry.reason.length, name).toBeGreaterThan(5);
    }
  });
});
