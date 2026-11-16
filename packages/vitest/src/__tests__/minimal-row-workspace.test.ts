import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { minimalRowExpectedFailures } from '../minimal-row-expected-failures.js';

const packagesDir = resolve(__dirname, '../../../..', 'packages');
const generated = 'src/__tests__/minimal-row.generated.test.ts';
const expectedSource =
  "import { registerMinimalRowTests } from '@happyvertical/smrt-vitest/minimal-row';\n\nawait registerMinimalRowTests();\n";
const modelBaseNames = new Set([
  'SmrtObject',
  'SmrtHierarchical',
  'SmrtPolymorphicAssociation',
  'SmrtReport',
]);
for (const directory of readdirSync(packagesDir)) {
  for (const relative of ['dist/manifest.json', 'dist/lib/manifest.json']) {
    const file = join(packagesDir, directory, relative);
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const entry of Object.values(manifest.objects ?? {}) as {
      className: string;
      collectionOf?: string;
    }[]) {
      if (!entry.collectionOf) modelBaseNames.add(entry.className);
    }
  }
}

function configIncludesGeneratedTest(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const projects: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'test' &&
      ts.isObjectLiteralExpression(node.initializer) &&
      !node.initializer.properties.some(
        (property) => property.name?.getText(source) === 'projects',
      )
    ) {
      projects.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return projects.some((project) => {
    function patterns(name: string, fallback: string[]): string[] {
      const property = project.properties.find(
        (property) => property.name?.getText(source) === name,
      );
      if (!property || !ts.isPropertyAssignment(property)) return fallback;
      if (!ts.isArrayLiteralExpression(property.initializer))
        throw new Error(
          `${file}: ${name} must be inspected for minimal-row discovery`,
        );
      return property.initializer.elements
        .filter(ts.isStringLiteral)
        .map((literal) => literal.text);
    }
    return (
      patterns('include', ['**/*.{test,spec}.?(c|m)[jt]s?(x)']).some(
        (pattern) => matchesGlob(generated, pattern),
      ) &&
      !patterns('exclude', []).some((pattern) =>
        matchesGlob(generated, pattern),
      )
    );
  });
}

function hasSourceModel(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return (
        !/^(?:__tests__|fixtures|test-support|test|tests|types)$/.test(
          entry.name,
        ) && hasSourceModel(file)
      );
    }
    if (!file.endsWith('.ts') || /\.(test|spec|d)\.ts$/.test(file))
      return false;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    return source.statements.some((statement) => {
      if (!ts.isClassDeclaration(statement)) return false;
      const decorators = ts.canHaveDecorators(statement)
        ? ts.getDecorators(statement)
        : [];
      return (
        decorators?.some(
          (decorator) =>
            ts.isCallExpression(decorator.expression) &&
            decorator.expression.expression.getText(source) === 'smrt',
        ) ||
        statement.heritageClauses?.some((clause) =>
          clause.types.some((type) =>
            modelBaseNames.has(type.expression.getText(source)),
          ),
        )
      );
    });
  });
}

describe('minimal-row workspace coverage', () => {
  it('keeps each known defect attributable to one model, field and error', () => {
    expect(
      new Set(minimalRowExpectedFailures.map((entry) => entry.model)).size,
    ).toBe(minimalRowExpectedFailures.length);
    for (const entry of minimalRowExpectedFailures) {
      expect(entry.model).toMatch(/^@[^:]+:[^:]+$/);
      expect(entry.field.trim()).not.toBe('');
      expect(entry.reason.trim()).not.toBe('');
      expect(entry.error.trim()).not.toBe('');
    }
  });
  it('requires the same generated test in every package declaring models', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const directory of readdirSync(packagesDir)) {
      const root = join(packagesDir, directory);
      if (!existsSync(join(root, 'package.json'))) continue;
      const manifestPath = [
        join(root, 'dist/manifest.json'),
        join(root, 'dist/lib/manifest.json'),
      ].find(existsSync);
      const manifest = manifestPath
        ? JSON.parse(readFileSync(manifestPath, 'utf8'))
        : undefined;
      const packageName = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      ).name;
      const hasManifestModels = Object.values(manifest?.objects ?? {}).some(
        (value) => {
          const entry = value as {
            packageName?: string;
            collectionOf?: string;
            filePath?: string;
          };
          return (
            entry.packageName === packageName &&
            !entry.collectionOf &&
            !/\.(test|spec)\./.test(entry.filePath ?? '')
          );
        },
      );
      if (!hasManifestModels && !hasSourceModel(join(root, 'src'))) continue;
      checked++;
      const file = join(root, generated);
      if (!existsSync(file))
        missing.push(`${packageName}: missing ${generated}`);
      else if (readFileSync(file, 'utf8') !== expectedSource)
        missing.push(
          `${packageName}: generated test must call the shared registry contract without per-model code`,
        );
      const config = join(root, 'vitest.config.ts');
      if (!existsSync(config) || !configIncludesGeneratedTest(config))
        missing.push(
          `${packageName}: Vitest config does not include ${generated}`,
        );
    }
    expect(checked).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});
