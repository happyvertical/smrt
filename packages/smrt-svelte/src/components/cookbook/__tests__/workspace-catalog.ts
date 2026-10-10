/**
 * The real workspace recipes for cookbook tests (#3749): scan every package
 * that declares a `SmrtRecipe` and convert each to a manifest exactly as the
 * build does, so the catalog is what the published manifests carry without
 * depending on sibling `dist/` artifacts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { type CookbookManifest, catalogFromManifests } from '../catalog.js';
import type { CookbookCatalog } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../../../../..');
export const FIXTURES = join(
  REPO_ROOT,
  'packages/core/src/cookbook/__fixtures__',
);

export const FIXTURE_NAMES = [
  'bakery',
  'mechanic',
  'welder',
  'yoga-studio',
] as const;

export function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.cookbook.json`), 'utf8'),
  );
}

function recipePackages(): string[] {
  const out = execFileSync(
    'git',
    ['grep', '-l', 'extends SmrtRecipe', '--', 'packages'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return [
    ...new Set(
      out
        .split('\n')
        .filter(
          (file) =>
            file.endsWith('/recipes.ts') &&
            !file.startsWith('packages/scanner/') &&
            !file.startsWith('packages/core/'),
        )
        .map((file) => file.split('/').slice(0, 2).join('/')),
    ),
  ].sort();
}

let cached: Promise<CookbookCatalog> | undefined;

/** Recipes and models of every workspace package that declares a recipe. */
export function workspaceCatalog(): Promise<CookbookCatalog> {
  cached ??= (async () => {
    const manifests: CookbookManifest[] = [];
    for (const pkg of recipePackages()) {
      const cwd = join(REPO_ROOT, pkg);
      if (!existsSync(cwd)) continue;
      const packageName = (
        JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
          name: string;
        }
      ).name;
      const scanner = new OxcScanner({
        cwd,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName,
        packageVersion: '0.0.0',
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      manifests.push(manifest as unknown as CookbookManifest);
    }
    return catalogFromManifests(manifests);
  })();
  return cached;
}
