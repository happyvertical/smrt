/**
 * `save()` override signature guard (#4408).
 *
 * `SmrtObject.save(options: SmrtSaveOptions = {})` carries `expectedUpdatedAt`
 * and other save options. A subclass that declares `override async save()`
 * with no parameter, or calls `super.save()` with no argument, makes the
 * options unreachable (type error) or silently drops them when cast.
 *
 * An override that declares a `save(options...)` parameter but never references
 * it in its body drops the options just as surely (the commerce money-document
 * overrides did exactly this), so that shape fails too.
 *
 * This scans non-test `packages/*\/src/**\/*.ts` for these shapes and fails
 * listing every offender.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = resolve(__dirname, '../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '.svelte-kit']);
const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;

function collectSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        collectSources(join(dir, entry.name), out);
    } else if (
      /\.ts$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name) &&
      !TEST_FILE.test(entry.name)
    ) {
      out.push(join(dir, entry.name));
    }
  }
}

function findOffenders(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES_DIR, pkg.name, 'src');
    try {
      collectSources(src, files);
    } catch {
      // package without a src directory
    }
  }

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('save')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const where = (node: ts.Node, what: string) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      offenders.push(`${relative(PACKAGES_DIR, file)}:${line + 1} ${what}`);
    };
    const references = (body: ts.Node, name: string): boolean => {
      let found = false;
      const walk = (n: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(n) && n.text === name) found = true;
        else ts.forEachChild(n, walk);
      };
      walk(body);
      return found;
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'save' &&
        node.body &&
        node.parameters.length > 0 &&
        ts.isClassDeclaration(node.parent) &&
        node.parent.heritageClauses?.some(
          (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
        ) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.OverrideKeyword)
      ) {
        const [first] = node.parameters;
        // A destructured parameter binds names, not one identifier; the check
        // below only covers the plain `options` parameter shape.
        // An underscore-prefixed name marks a deliberately unused parameter
        // (a save() that always throws).
        if (
          ts.isIdentifier(first.name) &&
          !first.name.text.startsWith('_') &&
          !references(node.body, first.name.text)
        ) {
          where(
            node,
            `override save(${first.name.text}) never uses its parameter`,
          );
        }
      }
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'save' &&
        node.parameters.length === 0 &&
        ts.isClassDeclaration(node.parent) &&
        node.parent.heritageClauses?.some(
          (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
        ) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.OverrideKeyword)
      ) {
        where(node, 'override save() takes no parameter');
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 0 &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.SuperKeyword &&
        node.expression.name.text === 'save'
      ) {
        where(node, 'super.save() does not forward options');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return offenders.sort();
}

describe('save() override signature (#4408)', () => {
  it('forwards SmrtSaveOptions through every model save() override', () => {
    expect(findOffenders()).toEqual([]);
  });
});
