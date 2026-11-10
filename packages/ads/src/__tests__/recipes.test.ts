import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AdDeliveryTier,
  AdFormat,
  AdGroup,
  AdsCampaignsRecipe,
  AdVariation,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-ads';

describe('ads recipes (#4409)', () => {
  it('declares Ads over the campaign, ad, size and tier models', () => {
    expect(AdsCampaignsRecipe.id).toBe('ads.campaigns');
    expect(AdsCampaignsRecipe.label).toBe('Ads');
    expect(AdsCampaignsRecipe.models).toEqual([
      AdGroup,
      AdVariation,
      AdFormat,
      AdDeliveryTier,
    ]);
    expect(AdsCampaignsRecipe).not.toHaveProperty('exposure');
    expect(AdsCampaignsRecipe.nav.map((entry) => entry.label)).toEqual([
      'Ad campaigns',
      'Ads',
      'Ad sizes',
      'Priority tiers',
    ]);
  });

  describe('scanned and emitted', () => {
    let recipes: RecipeDefinition[];
    let errors: string[];
    let objects: Record<string, { decoratorConfig?: Record<string, unknown> }>;

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
      objects = manifest.objects as typeof objects;
    });

    it('passes scanner validation and the generation checks', () => {
      expect(errors).toEqual([]);
    });

    it('emits the recipe with its label and plain-words help', () => {
      const recipe = recipes.find((entry) => entry.id === 'ads.campaigns');
      expect(recipe?.label).toBe('Ads');
      expect(recipe?.help?.markdown).toContain('## Tasks');
      expect(recipe?.help?.markdown).toContain(
        'An ad with weight 2 shows twice as often as one with weight 1',
      );
      expect(recipe?.help?.fieldRefs.length).toBeGreaterThan(0);
      expect(recipe?.help?.markdown).not.toMatch(
        /\b(json|api|rest|mcp|sql|uuid)\b/i,
      );
    });

    it('leaves the serving log out and exposes every nav model', () => {
      const recipe = recipes.find((entry) => entry.id === 'ads.campaigns');
      expect(recipe?.models).not.toContain(`${PACKAGE}:AdEvent`);
      for (const entry of recipe?.nav ?? []) {
        const name = entry.model.slice(entry.model.indexOf(':') + 1);
        const object = objects[entry.model] ?? objects[name];
        const api = object?.decoratorConfig?.api as
          | { include?: string[] }
          | undefined;
        expect(api?.include, entry.model).toContain('list');
      }
    });
  });
});
