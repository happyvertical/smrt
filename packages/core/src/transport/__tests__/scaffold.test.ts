/**
 * The transport kernel scaffold (#5158): fixed signatures, no behaviour.
 *
 * Every kernel function exists so later work can be written against it, and
 * every one refuses to run. Nothing in any package calls the kernel yet; this
 * file fails if that stops being true before the kernel is implemented.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as browserEntry from '../../browser';
import * as nodeEntry from '../../index';
import * as kernel from '../../transport';
import { TransportNotImplementedError } from '../not-implemented';

const CORE_SRC = new URL('../../', import.meta.url).pathname;
const PACKAGES = new URL('../../../../', import.meta.url).pathname;

/** Every kernel function, the file that owns it, and who implements it. */
const STUBS: Array<[name: keyof typeof kernel, file: string, owner: string]> = [
  ['toTransportError', 'errors.ts', 'K1'],
  ['resolveTransportModel', 'model.ts', 'K2'],
  ['resolveCollectionSegment', 'model.ts', 'K2'],
  ['principalFromLocals', 'principal.ts', 'K2'],
  ['principalFromContext', 'principal.ts', 'K2'],
  ['principalFromEnv', 'principal.ts', 'K2'],
  ['describeOperation', 'authorize.ts', 'K2'],
  ['authorizeOperation', 'authorize.ts', 'K2'],
  ['resolveWritableFields', 'input.ts', 'K3'],
  ['filterWriteInput', 'input.ts', 'K3'],
  ['applyWriteInput', 'input.ts', 'K3'],
  ['parseListQuery', 'query.ts', 'K4'],
  ['runInTenantGate', 'tenant.ts', 'K5'],
  ['toPublic', 'project.ts', 'K6'],
  ['executeOperation', 'operations.ts', 'K7'],
  ['readJsonBody', 'http.ts', 'K7'],
  ['createHttpHandlers', 'http.ts', 'K7'],
  ['validateToolArguments', 'mcp.ts', 'K7'],
  ['createMcpToolRuntime', 'mcp.ts', 'K7'],
  ['createSyncApplyHost', 'sync.ts', 'K7'],
];

const kernelExports = new Map<string, unknown>(Object.entries(kernel));

const CONCERN_FILES = [
  'authorize.ts',
  'errors.ts',
  'http.ts',
  'input.ts',
  'mcp.ts',
  'model.ts',
  'operations.ts',
  'principal.ts',
  'project.ts',
  'query.ts',
  'sync.ts',
  'tenant.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (
      /\.(ts|mts|js|mjs|svelte)$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(path);
    }
  }
  return out;
}

function moduleSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('transport')) return [];
  if (file.endsWith('.svelte')) {
    return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  }
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
    if (specifier && ts.isStringLiteralLike(specifier))
      found.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

describe('transport kernel scaffold', () => {
  it('gives each later concern exactly one file', () => {
    const files = readdirSync(join(CORE_SRC, 'transport'))
      .filter((name) => name.endsWith('.ts'))
      .sort();
    expect(files).toEqual(
      [...CONCERN_FILES, 'not-implemented.ts', 'profile.ts', 'types.ts'].sort(),
    );
    expect([...new Set(STUBS.map(([, file]) => file))].sort()).toEqual(
      CONCERN_FILES,
    );
  });

  it.each(
    STUBS,
  )('%s (%s) is exported and refuses to run until %s', (name, file, owner) => {
    const fn = kernelExports.get(name) as (...args: unknown[]) => unknown;
    expect(fn).toBeTypeOf('function');
    let thrown: unknown;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TransportNotImplementedError);
    expect((thrown as TransportNotImplementedError).feature).toBe(
      `transport.${name}`,
    );
    expect((thrown as Error).message).toContain('not implemented in K0');
    expect((thrown as Error).message).toContain(`lands with ${owner}`);
    // The declaring file documents the contract its owner has to meet.
    const source = readFileSync(join(CORE_SRC, 'transport', file), 'utf8');
    expect(source).toContain(`export function ${name}`);
    expect(source).toMatch(/\* Contract/);
  });

  it('exports every stub and nothing unexplained from the barrel', () => {
    const functions = Object.entries(kernel)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(
      [
        ...STUBS.map(([name]) => name),
        'notImplemented',
        'TransportNotImplementedError',
      ].sort(),
    );
  });

  it('publishes ./transport and ./error-contract with no browser override', () => {
    const pkg = JSON.parse(
      readFileSync(join(CORE_SRC, '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, Record<string, string>> };
    for (const name of ['transport', 'error-contract']) {
      expect(pkg.exports[`./${name}`], name).toEqual({
        types: `./dist/${name}.d.ts`,
        import: `./dist/${name}.js`,
        default: `./dist/${name}.js`,
      });
    }
  });

  it('is server-only: absent from the root and browser entries', () => {
    for (const name of Object.keys(kernel)) {
      expect(nodeEntry, name).not.toHaveProperty(name);
      expect(browserEntry, name).not.toHaveProperty(name);
    }
  });

  it('is imported by nothing outside itself', () => {
    const kernelDir = join(CORE_SRC, 'transport') + sep;
    const barrel = join(CORE_SRC, 'transport.ts');
    const importers: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, pkg, 'src');
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      const isCore = join(src, sep) === CORE_SRC;
      for (const file of walk(src)) {
        if (file.startsWith(kernelDir) || file === barrel) continue;
        for (const specifier of moduleSpecifiers(file)) {
          const viaPackage = /^@happyvertical\/smrt-core\/transport(\/|$)/.test(
            specifier,
          );
          let viaPath = false;
          if (isCore && specifier.startsWith('.')) {
            const target = join(file, '..', specifier).replace(
              /\.(js|ts)$/,
              '',
            );
            viaPath =
              target === barrel.replace(/\.ts$/, '') ||
              `${target}${sep}`.startsWith(kernelDir);
          }
          if (viaPackage || viaPath) {
            importers.push(`${relative(PACKAGES, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(importers).toEqual([]);
  });
});
