import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import { OxcScanner } from '../scanner.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Packages whose source declares a recipe (`extends SmrtRecipe`). */
function recipePackages(): string[] {
  const out = execFileSync(
    'git',
    ['grep', '-l', 'extends SmrtRecipe', '--', 'packages'],
    { cwd: root, encoding: 'utf8' },
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

describe('every workspace recipe (#3708 review gaps)', {
  timeout: 120_000,
}, () => {
  const all: Array<{ pkg: string; recipe: RecipeDefinition }> = [];
  const errors: string[] = [];

  it('scans and validates every moved recipe', async () => {
    const packages = recipePackages();
    expect(packages.length).toBeGreaterThan(0);
    for (const pkg of packages) {
      const cwd = join(root, pkg);
      if (!existsSync(cwd)) continue;
      const scanner = new OxcScanner({
        cwd,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results } = await scanner.scanAndResolve();
      for (const error of results.errors) {
        errors.push(`${pkg}: ${error.message}`);
      }
      for (const recipe of results.recipes) all.push({ pkg, recipe });
    }
    expect(errors).toEqual([]);
    expect(all.length).toBeGreaterThanOrEqual(19);
  });

  it('has unique ids, existing requires and requiresAny, and agreeing labels', () => {
    const ids = new Set(all.map(({ recipe }) => recipe.id));
    expect(ids.size).toBe(all.length);
    const problems: string[] = [];
    const labels = new Map<string, string>();
    for (const { recipe } of all) {
      for (const id of recipe.requires) {
        if (!ids.has(id)) problems.push(`${recipe.id} requires unknown ${id}`);
      }
      for (const id of (recipe.requiresAny ?? []).flat()) {
        if (!ids.has(id)) {
          problems.push(`${recipe.id} requiresAny unknown ${id}`);
        }
      }
      for (const [kind, value] of [
        ['group', recipe.group],
        ['section', recipe.section],
      ] as const) {
        if (!value) continue;
        const key = `${kind}:${value.id}`;
        const seen = labels.get(key);
        if (seen !== undefined && seen !== value.label) {
          problems.push(`${key} labelled "${seen}" and "${value.label}"`);
        }
        labels.set(key, value.label);
      }
    }
    expect(problems).toEqual([]);
  });
});
