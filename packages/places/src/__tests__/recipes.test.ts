import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition, SmrtManifest } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { Place, PlacesLocationsRecipe, PlaceType } from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-places';

describe('places recipes (#4409)', () => {
  it('declares Places over Place and PlaceType, exposed', () => {
    expect(PlacesLocationsRecipe.id).toBe('places.locations');
    expect(PlacesLocationsRecipe.label).toBe('Places');
    expect(PlacesLocationsRecipe.models).toEqual([Place, PlaceType]);
    expect(PlacesLocationsRecipe.exposure).toBeUndefined();
    expect(PlacesLocationsRecipe.nav.map((entry) => entry.model)).toEqual([
      Place,
      PlaceType,
    ]);
  });

  it('describes the inherited parentId through options help', () => {
    expect(PlacesLocationsRecipe.options.Place.fields.parentId.help).toMatch(
      /larger place/,
    );
  });

  describe('scanned and emitted', () => {
    let manifest: SmrtManifest;
    let recipes: RecipeDefinition[];
    let errors: string[];

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageRoot,
        include: ['src/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/*.spec.ts',
          '**/__tests__/**',
          '**/*.d.ts',
        ],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      errors = results.errors
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.filePath}: ${diagnostic.message}`);
      manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: PACKAGE,
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      // The build derives this from the dependency tree; it lets the generator
      // merge `SmrtHierarchical.parentId` from core's manifest into Place, the
      // same way the shipped manifest.json carries it.
      manifest.smrtDependencies = ['@happyvertical/smrt-core'];
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
        packageJson: JSON.parse(
          readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
        ),
      });
      recipes = manifest.recipes ?? [];
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits the recipe with its label and plain-words help', () => {
      const recipe = recipes.find((entry) => entry.id === 'places.locations');
      expect(recipe?.label).toBe('Places');
      expect(recipe?.exposure).toBeUndefined();
      expect(recipe?.help?.markdown).toContain('## Overview');
      expect(recipe?.help?.markdown).toContain('choose **New**');
      expect(recipe?.help?.fieldRefs?.length).toBeGreaterThan(0);
      expect(recipe?.help?.fieldRefs).toContain('Place.parentId');
    });

    it('exposes every nav model on the generated surface', () => {
      const recipe = recipes.find((entry) => entry.id === 'places.locations');
      for (const entry of recipe?.nav ?? []) {
        const model =
          manifest.objects[entry.model] ??
          Object.values(manifest.objects).find(
            (candidate) =>
              (candidate.qualifiedName ?? candidate.className) === entry.model,
          );
        expect(model, entry.model).toBeDefined();
        const api = model?.decoratorConfig?.api;
        expect(
          api && typeof api === 'object' && 'include' in api
            ? api.include
            : api,
          entry.model,
        ).toContain('list');
      }
    });
  });
});
