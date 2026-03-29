import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  name?: string;
  exports?: Record<string, unknown>;
}

function hasAnyPath(packageDir: string, paths: string[]): boolean {
  return paths.some((relativePath) =>
    existsSync(join(packageDir, relativePath)),
  );
}

function isWorkspaceModelPackage(packageDir: string): boolean {
  return hasAnyPath(packageDir, [
    'src/models',
    'src/collections',
    'src/lib/models',
    'src/lib/collections',
    'src/manifest/manifest.json',
  ]);
}

describe('Workspace package manifest exports', () => {
  it('requires model packages to expose both manifest entry aliases', () => {
    const packagesRoot = join(process.cwd(), '..');
    const packageDirs = readdirSync(packagesRoot)
      .map((dirName) => join(packagesRoot, dirName))
      .filter((packageDir) => existsSync(join(packageDir, 'package.json')))
      .filter(isWorkspaceModelPackage);

    const missingExports = packageDirs.flatMap((packageDir) => {
      const packageJson = JSON.parse(
        readFileSync(join(packageDir, 'package.json'), 'utf8'),
      ) as PackageMetadata;
      const packageName =
        packageJson.name || packageDir.replace(`${packagesRoot}/`, '');
      const exportsField = packageJson.exports || {};
      const missingAliases: string[] = [];

      if (!('./manifest' in exportsField)) {
        missingAliases.push('./manifest');
      }

      if (!('./manifest.json' in exportsField)) {
        missingAliases.push('./manifest.json');
      }

      return missingAliases.length > 0
        ? [`${packageName}: ${missingAliases.join(', ')}`]
        : [];
    });

    expect(missingExports).toEqual([]);
  });
});
