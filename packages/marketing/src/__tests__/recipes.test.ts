import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Campaign,
  CampaignChannel,
  CampaignMetricSnapshot,
  MarketingCampaignsRecipe,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-marketing';

describe('marketing recipes (#4409)', () => {
  it('declares Campaigns over the campaign, channel and results models', () => {
    expect(MarketingCampaignsRecipe.id).toBe('marketing.campaigns');
    expect(MarketingCampaignsRecipe.label).toBe('Campaigns');
    expect(MarketingCampaignsRecipe.models).toEqual([
      Campaign,
      CampaignChannel,
      CampaignMetricSnapshot,
    ]);
    expect(MarketingCampaignsRecipe.exposure).toBeUndefined();
    expect(MarketingCampaignsRecipe.section.id).toBe('grow');
    expect(MarketingCampaignsRecipe.nav.map((entry) => entry.label)).toEqual([
      'Campaigns',
      'Channels',
      'Results',
    ]);
  });

  describe('scanned and emitted', () => {
    let recipes: RecipeDefinition[];
    let errors: string[];
    let exposedModels: Set<string>;

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
      exposedModels = new Set(
        resolved
          .filter((model) => {
            const config = (model.decoratorConfig ?? {}) as Record<
              string,
              unknown
            >;
            return ['api', 'mcp', 'cli'].some((surface) => {
              const value = config[surface];
              if (value === false || value === undefined) return false;
              if (value === true) return true;
              const include = (value as { include?: string[] }).include;
              return !Array.isArray(include) || include.includes('list');
            });
          })
          .map((model) => `${PACKAGE}:${model.className}`),
      );
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits the Campaigns recipe with its help', () => {
      const recipe = recipes.find(
        (entry) => entry.id === 'marketing.campaigns',
      );
      expect(recipe?.label).toBe('Campaigns');
      expect(recipe?.help?.markdown).toContain('## Tasks');
      expect(recipe?.help?.markdown).toContain('cents');
      expect(recipe?.help?.fieldRefs?.length).toBeGreaterThan(0);
    });

    it('lists every nav model on an exposed surface', () => {
      const recipe = recipes.find(
        (entry) => entry.id === 'marketing.campaigns',
      );
      for (const entry of recipe?.nav ?? []) {
        expect(exposedModels.has(entry.model)).toBe(true);
      }
    });
  });
});
