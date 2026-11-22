/**
 * Unit tests for the one generated-route predicate, the read-only directory
 * inspection, the route-file plan and its commit, and the source guard that
 * keeps route files reaching disk only through the plan (#5437).
 *
 * Inspection and read failures are injected through the file-system seam;
 * no test relies on file modes.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationRouteConflictError,
  destinationCaseBehaviour,
  findUnlistableRouteDirectories,
  inspectRouteDirectory,
  isGeneratedRouteFile,
  isGeneratedRouteSource,
  nodeRouteFileSystem,
  RouteFilePlan,
  type RouteFileSystem,
  removeGeneratedRouteFile,
} from './generated-route-files.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';

const HEADER = AUTO_GENERATED_ROUTE_HEADER;
const GENERATED = `${HEADER}\n// DO NOT EDIT\nexport const GET = 1;\n`;
const APPLICATION = "export const GET = () => new Response('app');\n";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smrt-generated-route-files-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function place(relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function failing(code: string): never {
  throw Object.assign(new Error(`${code}: injected`), { code });
}

/** The node seam with selected calls replaced for one path. */
function seamWith(overrides: Partial<RouteFileSystem>): RouteFileSystem {
  return { ...nodeRouteFileSystem, ...overrides };
}

describe('the generated-route predicate', () => {
  it('a route file starting with the header and a newline is generator output', () => {
    expect(isGeneratedRouteSource(GENERATED)).toBe(true);
    expect(isGeneratedRouteFile(place('a/+server.ts', GENERATED))).toBe(true);
    // The same bytes under +server.js are application code.
    expect(isGeneratedRouteFile(place('a/+server.js', GENERATED))).toBe(false);
  });

  it('a generated route re-saved with CRLF line endings is generator output', () => {
    const crlf = GENERATED.replaceAll('\n', '\r\n');
    expect(isGeneratedRouteSource(crlf)).toBe(true);
    expect(isGeneratedRouteFile(place('crlf/+server.ts', crlf))).toBe(true);
  });

  it('a generated route with one byte-order mark is generator output', () => {
    expect(isGeneratedRouteSource(`﻿${GENERATED}`)).toBe(true);
    expect(isGeneratedRouteFile(place('bom/+server.ts', `﻿${GENERATED}`))).toBe(
      true,
    );
    expect(isGeneratedRouteSource(`﻿﻿${GENERATED}`)).toBe(false);
  });

  it.each([
    ['a banner', `// Copyright Example\n${GENERATED}`],
    ['a ts-nocheck directive', `// @ts-nocheck\n${GENERATED}`],
    ['a blank line', `\n${GENERATED}`],
  ])('content before the header makes a route file application code (%s)', (_label, text) => {
    expect(isGeneratedRouteSource(text)).toBe(false);
    expect(isGeneratedRouteFile(place('banner/+server.ts', text))).toBe(false);
  });

  it('an empty or unreadable route file is application code', () => {
    const empty = place('empty/+server.ts', '');
    expect(isGeneratedRouteFile(empty)).toBe(false);

    const file = place('unreadable/+server.ts', GENERATED);
    const fs = seamWith({
      readFileSync: (path) =>
        path === file
          ? failing('EACCES')
          : nodeRouteFileSystem.readFileSync(path),
    });
    expect(isGeneratedRouteFile(file, fs)).toBe(false);
    expect(
      inspectRouteDirectory(root, join(root, 'unreadable'), fs),
    ).toMatchObject({
      blocking: [],
      application: [{ file, reason: 'cannot be read (EACCES)' }],
    });
  });

  it('a symlinked route file is application code', () => {
    const target = place('outside/real.ts', GENERATED);
    mkdirSync(join(root, 'linked'), { recursive: true });
    symlinkSync(target, join(root, 'linked/+server.ts'));
    expect(isGeneratedRouteFile(join(root, 'linked/+server.ts'))).toBe(false);
  });
});

describe('inspecting a planned route directory', () => {
  it.each([
    'EACCES',
    'ENOTDIR',
  ])('a route directory that cannot be inspected refuses (%s on a path component)', (code) => {
    mkdirSync(join(root, 'routes/lanterns'), { recursive: true });
    const component = join(root, 'routes/lanterns');
    const fs = seamWith({
      lstatSync: (path) =>
        path === component
          ? failing(code)
          : nodeRouteFileSystem.lstatSync(path),
    });
    expect(
      inspectRouteDirectory(join(root, 'routes'), join(component, '[id]'), fs),
    ).toEqual({
      blocking: [{ file: component, reason: `cannot be inspected (${code})` }],
      application: [],
    });
  });

  it('a route directory that cannot be inspected refuses (EACCES on the endpoint file)', () => {
    const directory = join(root, 'routes/lanterns');
    mkdirSync(directory, { recursive: true });
    const leaf = join(directory, '+server.ts');
    const fs = seamWith({
      lstatSync: (path) =>
        path === leaf ? failing('EACCES') : nodeRouteFileSystem.lstatSync(path),
    });
    expect(
      inspectRouteDirectory(join(root, 'routes'), directory, fs).blocking,
    ).toEqual([{ file: leaf, reason: 'cannot be inspected (EACCES)' }]);
  });

  it('a dangling directory link under the routes root refuses (deeper component)', () => {
    mkdirSync(join(root, 'routes/lanterns'), { recursive: true });
    const link = join(root, 'routes/lanterns/[id]');
    symlinkSync(join(root, 'missing'), link);
    expect(
      inspectRouteDirectory(join(root, 'routes'), join(link, 'light')),
    ).toEqual({
      blocking: [
        { file: link, reason: 'is a symbolic link whose target is missing' },
      ],
      application: [],
    });
    // A linked component whose target cannot be inspected refuses as well.
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    const opaque = join(root, 'routes/lanterns/opaque');
    symlinkSync(join(root, 'elsewhere'), opaque);
    const fs = seamWith({
      statSync: (path) =>
        path === opaque
          ? failing('EACCES')
          : nodeRouteFileSystem.statSync(path),
    });
    expect(
      inspectRouteDirectory(join(root, 'routes'), opaque, fs).blocking,
    ).toEqual([
      {
        file: opaque,
        reason: 'is a symbolic link that cannot be inspected (EACCES)',
      },
    ]);
    // A genuinely missing component is absent, not blocking.
    expect(
      inspectRouteDirectory(
        join(root, 'routes'),
        join(root, 'routes/kites/[id]'),
      ),
    ).toEqual({ blocking: [], application: [] });
  });

  it('a linked route directory is inspected through its spelling', () => {
    place('real/+server.ts', APPLICATION);
    mkdirSync(join(root, 'routes'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'routes/alias'));
    expect(
      inspectRouteDirectory(join(root, 'routes'), join(root, 'routes/alias'))
        .application,
    ).toEqual([
      {
        file: join(root, 'routes/alias/+server.ts'),
        reason: 'does not start with the generated-route header',
      },
    ]);
  });

  it('reports a header below the first line for the yield rule', () => {
    const file = place(
      'routes/_resources/+server.ts',
      `// banner\n${GENERATED}`,
    );
    expect(
      inspectRouteDirectory(
        join(root, 'routes'),
        join(root, 'routes/_resources'),
      ).yieldBlocker,
    ).toEqual({ file, reason: 'has content above the generated-route header' });
  });

  it('a header mention on the first line is not a header below the first line', () => {
    place(
      'routes/sync/apply/+server.ts',
      `const marker = '${HEADER}';\n${APPLICATION}`,
    );
    const inspection = inspectRouteDirectory(
      join(root, 'routes'),
      join(root, 'routes/sync/apply'),
    );
    expect(inspection.yieldBlocker).toBeUndefined();
    expect(inspection.application).toHaveLength(1);
  });

  it.each([
    ['empty', ''],
    ['a strict prefix of the header', HEADER.slice(0, 9)],
    ['a byte-order mark and a prefix', `﻿${HEADER.slice(0, 9)}`],
  ])('an interrupted generated write blocks a yield route (%s)', (_label, text) => {
    const file = place('routes/_resources/+server.ts', text);
    expect(
      inspectRouteDirectory(
        join(root, 'routes'),
        join(root, 'routes/_resources'),
      ).yieldBlocker?.file,
    ).toBe(file);
  });

  it('inspects the ancestors of a destination outside the routes root', () => {
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    const link = join(root, 'src/shared');
    symlinkSync(join(root, 'missing'), link);
    expect(
      inspectRouteDirectory(
        join(root, 'src/routes'),
        join(root, 'src/shared/knowledge'),
      ).blocking,
    ).toEqual([
      { file: link, reason: 'is a symbolic link whose target is missing' },
    ]);
  });
});

describe('the sweep re-check', () => {
  it('the sweep re-checks a file immediately before unlinking it', () => {
    const file = place('routes/old/+server.ts', GENERATED);
    // The bytes are replaced after the sweep listed the file and before its
    // predicate read.
    const fs = seamWith({
      lstatSync: (path) => {
        if (path === file) writeFileSync(file, APPLICATION);
        return nodeRouteFileSystem.lstatSync(path);
      },
    });
    expect(removeGeneratedRouteFile(file, fs)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(APPLICATION);

    // Negative control: unchanged generated bytes are unlinked.
    const unchanged = place('routes/older/+server.ts', GENERATED);
    expect(removeGeneratedRouteFile(unchanged)).toBe(true);
    expect(existsSync(unchanged)).toBe(false);
  });
});

describe('the route-file plan', () => {
  const routes = () => join(root, 'routes');

  it('rejects emitted content that does not carry the header', () => {
    const plan = new RouteFilePlan();
    expect(() =>
      plan.emit({
        root: routes(),
        routeDir: join(routes(), 'a'),
        content: APPLICATION,
        label: 'a',
      }),
    ).toThrow(/must start with the generated-route header/);
  });

  it('keeps the later of two refuse emits on one path', () => {
    const plan = new RouteFilePlan();
    const routeDir = join(routes(), 'kites');
    plan.emit({
      root: routes(),
      routeDir,
      content: `${HEADER}\n// one\n`,
      label: 'Kite',
    });
    plan.emit({
      root: routes(),
      routeDir,
      content: `${HEADER}\n// two\n`,
      label: 'BoxKite',
    });
    expect(plan.entries()).toHaveLength(1);
    plan.preflight();
    plan.commit();
    expect(readFileSync(join(routeDir, '+server.ts'), 'utf-8')).toContain(
      'two',
    );
  });

  it('throws when a refuse emit and a yield emit share a path', () => {
    const plan = new RouteFilePlan();
    const routeDir = join(routes(), 'sync', 'apply');
    plan.emit({
      root: routes(),
      routeDir,
      content: GENERATED,
      label: 'action',
    });
    expect(() =>
      plan.emit({
        root: routes(),
        routeDir,
        content: GENERATED,
        label: 'sync/apply',
        policy: 'yield',
      }),
    ).toThrow(/^Conflicting SvelteKit route /);
  });

  it.each([
    [true, true],
    [false, false],
  ])('paths that differ only by case collide when the volume is case-insensitive (insensitive: %s)', (caseInsensitive, collides) => {
    const plan = new RouteFilePlan({ caseInsensitive });
    plan.emit({
      root: routes(),
      routeDir: join(routes(), 'Sync', 'apply'),
      content: GENERATED,
      label: 'Ledger action apply',
    });
    const yieldEmit = () =>
      plan.emit({
        root: routes(),
        routeDir: join(routes(), 'sync', 'apply'),
        content: GENERATED,
        label: 'sync/apply',
        policy: 'yield',
      });
    if (collides) {
      expect(yieldEmit).toThrow(/^Conflicting SvelteKit route /);
    } else {
      expect(yieldEmit).not.toThrow();
      expect(plan.entries()).toHaveLength(2);
    }
  });

  it('detects this volume as case-sensitive when a case-swapped name does not exist', () => {
    const plan = new RouteFilePlan();
    plan.emit({
      root: routes(),
      routeDir: join(root, 'Sync', 'apply'),
      content: GENERATED,
      label: 'a',
    });
    const caseInsensitive = existsSync(root.toUpperCase());
    expect(plan.claims(join(root, 'sync', 'apply'))).toBe(caseInsensitive);
  });

  it('throws when an emit targets a protected path, and claims() sees aliases', () => {
    mkdirSync(join(routes(), 'real'), { recursive: true });
    symlinkSync(join(routes(), 'real'), join(routes(), 'alias'));
    const protectedFile = join(resolve(routes(), 'real'), '+server.ts');
    const plan = new RouteFilePlan({
      protectedPaths: new Set([protectedFile]),
    });
    expect(() =>
      plan.emit({
        root: routes(),
        routeDir: join(routes(), 'alias'),
        content: GENERATED,
        label: 'knowledge',
      }),
    ).toThrow(/^Conflicting SvelteKit route /);

    const open = new RouteFilePlan();
    open.emit({
      root: routes(),
      routeDir: join(routes(), 'alias'),
      content: GENERATED,
      label: 'x',
    });
    expect(open.claims(join(routes(), 'real'))).toBe(true);
  });

  it('every conflict is reported in one preflight error', () => {
    const a = place('routes/a/+server.ts', APPLICATION);
    const b = place('routes/b/+server.js', APPLICATION);
    const plan = new RouteFilePlan();
    for (const name of ['a', 'b']) {
      plan.emit({
        root: routes(),
        routeDir: join(routes(), name),
        content: GENERATED,
        label: name,
      });
    }
    let caught: unknown;
    try {
      plan.preflight();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationRouteConflictError);
    expect(caught).toMatchObject({
      code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT',
      phase: 'preflight',
      files: [a, b],
      routes: ['a', 'b'],
    });
  });

  it('a file created at the destination during commit is not overwritten', () => {
    const routeDir = join(routes(), 'lanterns');
    const file = join(routeDir, '+server.ts');
    const written = place('routes/kites/+server.ts', GENERATED);
    rmSync(written);
    const plan = new RouteFilePlan({
      fs: seamWith({
        // The leaf looks absent when inspected; another writer creates it
        // before the exclusive write.
        lstatSync: (path) =>
          path === file && !existsSync(file)
            ? failing('ENOENT')
            : nodeRouteFileSystem.lstatSync(path),
        openSync: (path, flag) => {
          if (path === file && flag === 'wx') writeFileSync(file, APPLICATION);
          return nodeRouteFileSystem.openSync(path, flag);
        },
      }),
    });
    plan.emit({
      root: routes(),
      routeDir: join(routes(), 'kites'),
      content: GENERATED,
      label: 'kites',
    });
    plan.emit({
      root: routes(),
      routeDir,
      content: GENERATED,
      label: 'lanterns',
    });
    plan.preflight();

    let caught: unknown;
    try {
      plan.commit();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'ApplicationRouteConflictError',
      code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT',
      phase: 'commit',
      files: [file],
      written: [written],
    });
    expect((caught as Error).message).toContain(written);
    expect(readFileSync(file, 'utf-8')).toBe(APPLICATION);
  });

  it('a generated file found at a destination during commit is replaced', () => {
    const routeDir = join(routes(), 'lanterns');
    const file = join(routeDir, '+server.ts');
    const plan = new RouteFilePlan({
      fs: seamWith({
        openSync: (path, flag) => {
          if (path === file && flag === 'wx') {
            writeFileSync(file, `${HEADER}\n// stale\n`);
          }
          return nodeRouteFileSystem.openSync(path, flag);
        },
      }),
    });
    plan.emit({
      root: routes(),
      routeDir,
      content: GENERATED,
      label: 'lanterns',
    });
    plan.preflight();

    expect(plan.commit()).toEqual([file]);
    expect(readFileSync(file, 'utf-8')).toBe(GENERATED);
  });

  it('a create that fails while writing counts as a change', () => {
    const routeDir = join(routes(), 'gliders');
    const file = join(routeDir, '+server.ts');
    const plan = new RouteFilePlan({
      fs: seamWith({
        writeSync: () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          });
        },
      }),
    });
    plan.emit({
      root: routes(),
      routeDir,
      content: GENERATED,
      label: 'gliders',
    });
    plan.preflight();
    const onMutate = vi.fn();

    expect(() => plan.commit(onMutate)).toThrow(
      `${file} failed after it was opened`,
    );
    // The exclusive create succeeded before the write failed: a change.
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(true);
  });

  it('a yield route leaves an application handler in place and writes nothing', () => {
    const js = place('routes/_resources/+server.js', APPLICATION);
    const onYield = vi.fn();
    const plan = new RouteFilePlan();
    plan.emit({
      root: routes(),
      routeDir: join(routes(), '_resources'),
      content: GENERATED,
      label: '_resources',
      policy: 'yield',
      onYield,
    });
    plan.preflight();
    expect(plan.commit()).toEqual([]);
    expect(onYield).toHaveBeenCalledTimes(1);
    // The message names the application file actually found.
    expect(onYield).toHaveBeenCalledWith(js);
    expect(readFileSync(js, 'utf-8')).toBe(APPLICATION);
    expect(existsSync(join(routes(), '_resources/+server.ts'))).toBe(false);
  });
});

/**
 * A fake volume for case probes: `insensitiveRoot` and everything below it
 * resolve names case-insensitively (one inode per folded path); paths
 * elsewhere are case-sensitive. Only the calls the probe makes are faked.
 */
function caseVolume(
  insensitiveRoot: string,
  entries: Record<string, string[]>,
): RouteFileSystem {
  const inside = (path: string) =>
    path.toLowerCase() === insensitiveRoot.toLowerCase() ||
    path.toLowerCase().startsWith(`${insensitiveRoot.toLowerCase()}/`);
  const known = new Set<string>([
    insensitiveRoot,
    ...Object.entries(entries).flatMap(([directory, names]) => [
      directory,
      ...names.map((name) => join(directory, name)),
    ]),
  ]);
  const exists = (path: string) =>
    inside(path)
      ? [...known].some(
          (candidate) => candidate.toLowerCase() === path.toLowerCase(),
        )
      : known.has(path) ||
        path === '/' ||
        insensitiveRoot.startsWith(`${path}/`);
  const identity = (path: string) => (inside(path) ? path.toLowerCase() : path);
  return seamWith({
    statSync: (path) => {
      if (!exists(path)) failing('ENOENT');
      return {
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        ino: [...identity(path)].reduce(
          (sum, c) => (sum * 31 + c.charCodeAt(0)) % 1_000_000_007,
          7,
        ),
        dev: inside(path) ? 2 : 1,
      } as never;
    },
    readdirSync: (path) =>
      (entries[path] ?? []).map((name) => ({
        name,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      })),
  });
}

describe('case behaviour of the destination', () => {
  it('measures case behaviour inside the destination, not its mount point in the parent', () => {
    // /work is case-sensitive; /work/mnt is a case-insensitive mount whose
    // name, swapped in the parent, does not exist.
    const fs = caseVolume('/work/mnt', { '/work/mnt': ['Api'] });
    expect(destinationCaseBehaviour('/work/mnt/routes/Sync/apply', fs)).toBe(
      'insensitive',
    );
    const plan = new RouteFilePlan({ fs });
    plan.emit({
      root: '/work/mnt',
      routeDir: '/work/mnt/Sync/apply',
      content: GENERATED,
      label: 'Ledger action apply',
    });
    expect(() =>
      plan.emit({
        root: '/work/mnt',
        routeDir: '/work/mnt/sync/apply',
        content: GENERATED,
        label: 'sync/apply',
        policy: 'yield',
      }),
    ).toThrow(/^Conflicting SvelteKit route /);
  });

  it('this temporary volume is detected as case-sensitive', () => {
    place('routes/Probe.txt', '');
    expect(destinationCaseBehaviour(join(root, 'routes', 'x'))).toBe(
      existsSync(join(root, 'routes', 'PROBE.TXT'))
        ? 'insensitive'
        : 'sensitive',
    );
  });

  it('refuses case-only claims when the case behaviour cannot be determined', () => {
    // An empty destination directory has nothing to probe.
    mkdirSync(join(root, 'empty'), { recursive: true });
    expect(destinationCaseBehaviour(join(root, 'empty', 'Books'))).toBe(
      'unknown',
    );
    const plan = new RouteFilePlan();
    plan.emit({
      root: join(root, 'empty'),
      routeDir: join(root, 'empty', 'Books'),
      content: GENERATED,
      label: 'Book collection',
    });
    expect(() =>
      plan.emit({
        root: join(root, 'empty'),
        routeDir: join(root, 'empty', 'books'),
        content: GENERATED,
        label: 'Booklet collection',
      }),
    ).toThrow(/differ only by letter case/);
  });

  it.each([
    [true, true],
    [false, false],
  ])('a case-only alias of a protected knowledge route is protected (insensitive: %s)', (caseInsensitive, protectedAlias) => {
    const owned = join(root, 'routes', 'Docs', 'knowledge', '+server.ts');
    const plan = new RouteFilePlan({
      protectedPaths: new Set([owned]),
      caseInsensitive,
    });
    expect(plan.protects(join(root, 'routes', 'Docs', 'knowledge'))).toBe(true);
    expect(plan.protects(join(root, 'routes', 'docs', 'knowledge'))).toBe(
      protectedAlias,
    );
  });
});

describe('directories the sweep walks', () => {
  it('a directory the sweep cannot list is reported', () => {
    place('routes/a/+server.ts', GENERATED);
    place('routes/b/c/+server.ts', GENERATED);
    const blocked = join(root, 'routes', 'b');
    const fs = seamWith({
      readdirSync: (path) =>
        path === blocked
          ? failing('EACCES')
          : nodeRouteFileSystem.readdirSync(path),
    });
    expect(
      findUnlistableRouteDirectories(join(root, 'routes'), new Set(), fs),
    ).toEqual([{ file: blocked, reason: 'cannot be listed (EACCES)' }]);
    // Negative control: a listable tree reports nothing; a missing root too.
    expect(findUnlistableRouteDirectories(join(root, 'routes'))).toEqual([]);
    expect(findUnlistableRouteDirectories(join(root, 'absent'))).toEqual([]);
  });
});

/**
 * Route writers may read the file system but never mutate it: their route
 * files go into the plan. The generator's route-file mutations go only
 * through generated-route-files.ts.
 */
const FS_MODULES = new Set([
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
]);
const FS_READERS = new Set([
  'existsSync',
  'readFileSync',
  'lstatSync',
  'statSync',
  'readdirSync',
]);

const PROMISES_MODULES = new Set(['node:fs/promises', 'fs/promises']);

/** `fs` calls a module may make, keyed by the enclosing function's name. */
type AllowedMutations = Readonly<Record<string, readonly string[]>>;

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
  }
  return '<module>';
}

function isFsModuleSpecifier(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return FS_MODULES.has(node.text);
  }
  // A template literal with substitutions cannot be checked statically.
  return ts.isTemplateExpression(node);
}

/**
 * Every way `source` reaches a mutating file-system call outside `allowed`:
 * namespace, default, dynamic (string or template) and `fs/promises`
 * imports, and any call of a named `node:fs` import (renamed or not) that is
 * not a reader and not allowed in its enclosing function.
 */
function fsMutationViolations(
  source: string,
  allowed: AllowedMutations = {},
): string[] {
  const file = ts.createSourceFile(
    'module.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      FS_MODULES.has(node.moduleSpecifier.text)
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (PROMISES_MODULES.has(specifier) && !clause?.isTypeOnly) {
        violations.push(`import from ${specifier}`);
      }
      if (!clause || clause.name)
        violations.push('default or side-effect import');
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        violations.push('namespace import');
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          bindings.set(
            element.name.text,
            (element.propertyName ?? element.name).text,
          );
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      isFsModuleSpecifier(node.arguments[0])
    ) {
      violations.push('dynamic import');
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isFsModuleSpecifier(node.moduleReference.expression)
    ) {
      violations.push('import-equals');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const checkUses = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      bindings.has(node.text) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      const imported = bindings.get(node.text) ?? node.text;
      if (!FS_READERS.has(imported)) {
        const owner = enclosingFunctionName(node);
        const isCall =
          ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!isCall || !allowed[owner]?.includes(imported)) {
          violations.push(`${imported} in ${owner}`);
        }
      }
    }
    ts.forEachChild(node, checkUses);
  };
  checkUses(file);
  return violations;
}

/**
 * The generator's only direct file-system mutations: the auxiliary outputs
 * that keep their own writers (#5469). Route files go through the plan.
 */
const GENERATOR_AUXILIARY_MUTATIONS: AllowedMutations = {
  // Auxiliary in-place writes go through the route-fs seam's open/write in
  // `writeGeneratorOutput` (no direct `node:fs` mutation), so the generator
  // can record a change once an open succeeds (#5462).
  materializeBuildSchemaModule: ['mkdirSync'],
  generateRegistrationFile: ['mkdirSync'],
  generateSmrtConfigFile: ['mkdirSync'],
};

/** Modules that render route files: they import the header or the plan. */
/**
 * Every non-test module below `root` (recursively) with an import
 * declaration that resolves to `route-header.ts` or
 * `generated-route-files.ts` in `root`, as paths relative to `root`.
 */
function discoverRouteWriterModules(root = import.meta.dirname): string[] {
  const targets = new Set([
    resolve(root, 'route-header.ts'),
    resolve(root, 'generated-route-files.ts'),
  ]);
  const excluded = new Set([
    ...targets,
    resolve(root, 'sveltekit-generator.ts'),
    // The plugin entry reads the predicate for its watcher; it renders no
    // route file.
    resolve(root, 'index.ts'),
  ]);
  const resolveImport = (from: string, specifier: string): string => {
    const target = resolve(dirname(from), specifier);
    if (target.endsWith('.js')) return `${target.slice(0, -3)}.ts`;
    return target.endsWith('.ts') ? target : `${target}.ts`;
  };
  const modules: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
          walk(path);
        }
        continue;
      }
      if (
        !entry.name.endsWith('.ts') ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.d.ts') ||
        excluded.has(path)
      ) {
        continue;
      }
      const file = ts.createSourceFile(
        path,
        readFileSync(path, 'utf-8'),
        ts.ScriptTarget.Latest,
      );
      const importsTarget = file.statements.some(
        (statement) =>
          (ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.startsWith('.') &&
          targets.has(resolveImport(path, statement.moduleSpecifier.text)),
      );
      if (importsTarget) modules.push(relative(root, path));
    }
  };
  walk(root);
  return modules.sort();
}

describe('route files reach disk only through the route-file plan', () => {
  const read = (name: string) =>
    readFileSync(resolve(import.meta.dirname, name), 'utf-8');
  const writers = discoverRouteWriterModules();

  it('route files reach disk only through the route-file plan (negative: a nested writer fails through discovery)', () => {
    const fixture = join(root, 'plugin');
    place('plugin/route-header.ts', "export const HEADER = '//';\n");
    place('plugin/generated-route-files.ts', 'export class RouteFilePlan {}\n');
    place(
      'plugin/routes/nested-writer.ts',
      [
        "import { writeFileSync } from 'node:fs';",
        "import { HEADER } from '../route-header.js';",
        'export function emitNested() {',
        "  writeFileSync('x/+server.ts', HEADER);",
        '}',
        '',
      ].join('\n'),
    );
    place('plugin/unrelated.ts', "import { writeFileSync } from 'node:fs';\n");
    const found = discoverRouteWriterModules(fixture);
    expect(found).toEqual([join('routes', 'nested-writer.ts')]);
    expect(
      found.flatMap((name) =>
        fsMutationViolations(readFileSync(join(fixture, name), 'utf-8')),
      ),
    ).not.toEqual([]);
  });

  it('route files reach disk only through the route-file plan (writer discovery finds every known writer)', () => {
    expect(writers).toEqual(
      expect.arrayContaining([
        'changes-route.ts',
        'dev-plane-route.ts',
        'events-route.ts',
        'resources-route.ts',
        'sync-apply-route.ts',
      ]),
    );
  });

  it.each(
    writers,
  )('route files reach disk only through the route-file plan (%s)', (name) => {
    expect(fsMutationViolations(read(name))).toEqual([]);
  });

  it('route files reach disk only through the route-file plan (the generator)', () => {
    const source = read('sveltekit-generator.ts');
    expect(source).not.toMatch(/\bwriteRoute\b/);
    expect(fsMutationViolations(source, GENERATOR_AUXILIARY_MUTATIONS)).toEqual(
      [],
    );
  });

  it.each([
    ['a namespace import', "import * as fs from 'node:fs';"],
    ['a dynamic import', "const fs = await import('node:fs');"],
    [
      'a template-literal dynamic import',
      'const fs = await import(`node:fs`);',
    ],
    [
      'a mutating named import',
      "import { copyFileSync } from 'node:fs';\ncopyFileSync('a', 'b');",
    ],
    [
      'a renamed mutating import',
      "import { writeFileSync as w } from 'fs';\nw('a', 'b');",
    ],
    [
      'a promises import',
      "import { writeFile } from 'node:fs/promises';\nawait writeFile('a', 'b');",
    ],
    [
      'a directory creation',
      "import { mkdirSync } from 'node:fs';\nmkdirSync('a');",
    ],
  ])('route files reach disk only through the route-file plan (negative: %s fails the guard)', (_label, source) => {
    expect(fsMutationViolations(source)).not.toEqual([]);
  });

  it.each([
    [
      'a renamed write in a route writer',
      "import { writeFileSync as put } from 'node:fs';\nfunction emitRoute() { put('a', 'b'); }",
    ],
    [
      'an async write in a route writer',
      "import { writeFile } from 'node:fs/promises';\nasync function emitRoute() { await writeFile('a', 'b'); }",
    ],
    [
      'an allowed call name used outside its auxiliary function',
      "import { writeFileSync } from 'node:fs';\nfunction emitRoute() { writeFileSync('a', 'b'); }",
    ],
  ])('route files reach disk only through the route-file plan (negative: %s fails the generator guard)', (_label, source) => {
    expect(
      fsMutationViolations(source, GENERATOR_AUXILIARY_MUTATIONS),
    ).not.toEqual([]);
  });

  it('route files reach disk only through the route-file plan (negative: named readers pass)', () => {
    expect(
      fsMutationViolations(
        "import { existsSync, readFileSync } from 'node:fs';\nexistsSync('a');",
      ),
    ).toEqual([]);
  });
});
