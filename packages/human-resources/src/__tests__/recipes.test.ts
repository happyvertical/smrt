import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Employment,
  EmploymentTerm,
  HeldQualification,
  HumanResourcesPeopleRecipe,
  HumanResourcesQualificationsRecipe,
  Qualification,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-human-resources';

describe('human-resources recipes (#4440)', () => {
  it('declares Employees over the employment models, ui-only', () => {
    expect(HumanResourcesPeopleRecipe.id).toBe('human-resources.people');
    expect(HumanResourcesPeopleRecipe.label).toBe('Employees');
    expect(HumanResourcesPeopleRecipe.models).toEqual([
      Employment,
      EmploymentTerm,
    ]);
    expect(HumanResourcesPeopleRecipe.exposure).toBe('ui-only');
  });

  it('declares Qualifications over the qualification models, ui-only, after Employees', () => {
    expect(HumanResourcesQualificationsRecipe.id).toBe(
      'human-resources.qualifications',
    );
    expect(HumanResourcesQualificationsRecipe.models).toEqual([
      Qualification,
      HeldQualification,
    ]);
    expect(HumanResourcesQualificationsRecipe.exposure).toBe('ui-only');
    expect(HumanResourcesQualificationsRecipe.requires).toEqual([
      'human-resources.people',
    ]);
  });

  describe('scanned and emitted', () => {
    let recipes: RecipeDefinition[];
    let errors: string[];

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageRoot,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      errors = results.errors
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.filePath}: ${diagnostic.message}`);
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: PACKAGE,
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
        packageJson: JSON.parse(
          readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
        ),
      });
      recipes = manifest.recipes ?? [];
    });

    it('passes scanner validation, which rejects ui-only over an exposed model', () => {
      expect(errors).toEqual([]);
    });

    it('emits both recipes marked ui-only, with plain-words help', () => {
      const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
      for (const id of [
        'human-resources.people',
        'human-resources.qualifications',
      ]) {
        const recipe = byId.get(id);
        expect(recipe?.exposure).toBe('ui-only');
        expect(recipe?.help?.markdown).toContain('agent');
      }
      expect(byId.get('human-resources.people')?.label).toBe('Employees');
    });
  });
});
