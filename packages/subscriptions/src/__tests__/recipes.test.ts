import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type {
  RecipeDefinition,
  SmartObjectManifest,
} from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ClientCharge,
  SubscriptionPlan,
  SubscriptionPlansRecipe,
  SubscriptionPlanVersion,
  TenantSubscription,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-subscriptions';

describe('subscriptions recipes (#4409)', () => {
  it('declares Subscriptions over plans, versions, subscriptions and charges', () => {
    expect(SubscriptionPlansRecipe.id).toBe('subscriptions.plans');
    expect(SubscriptionPlansRecipe.label).toBe('Subscriptions');
    expect(SubscriptionPlansRecipe.models).toEqual([
      SubscriptionPlan,
      SubscriptionPlanVersion,
      TenantSubscription,
      ClientCharge,
    ]);
    expect(SubscriptionPlansRecipe.exposure).toBeUndefined();
    expect(SubscriptionPlansRecipe.section.id).toBe('sales');
  });

  describe('scanned and emitted', () => {
    let manifest: SmartObjectManifest;
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
      manifest = new ManifestAdapter().toManifest(resolved, {
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

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits the recipe with its label and help', () => {
      const recipe = recipes.find(
        (entry) => entry.id === 'subscriptions.plans',
      );
      expect(recipe?.label).toBe('Subscriptions');
      expect(recipe?.exposure).toBeUndefined();
      expect(recipe?.help?.markdown).toContain('## Overview');
      expect(recipe?.help?.markdown).toContain('## Tasks');
      expect(recipe?.help?.fieldRefs.length).toBeGreaterThan(0);
      expect(recipe?.help?.fieldRefs).toContain('SubscriptionPlan.priceAmount');
    });

    it('exposes every nav model to the generated surface', () => {
      const recipe = recipes.find(
        (entry) => entry.id === 'subscriptions.plans',
      );
      for (const entry of recipe?.nav ?? []) {
        const object = manifest.objects[entry.model];
        expect(object, entry.model).toBeDefined();
        const api = object.decoratorConfig.api as
          | { include?: string[] }
          | boolean
          | undefined;
        expect(api, entry.model).not.toBe(false);
        if (api && typeof api === 'object' && api.include) {
          expect(api.include, entry.model).toContain('list');
        }
      }
    });

    it('keeps money fields described in cents, never dollars', () => {
      const recipe = recipes.find(
        (entry) => entry.id === 'subscriptions.plans',
      );
      const money = [
        ['SubscriptionPlan', 'priceAmount'],
        ['SubscriptionPlanVersion', 'priceAmount'],
        ['TenantSubscription', 'agreedAmount'],
        ['ClientCharge', 'amount'],
      ] as const;
      for (const [model, field] of money) {
        const object = manifest.objects[`${PACKAGE}:${model}`];
        const text = object.fields[field]?.description ?? '';
        expect(text, `${model}.${field}`).toMatch(/in cents/);
        expect(text, `${model}.${field}`).not.toMatch(/dollar|\$/);
      }
      expect(recipe?.help?.markdown).not.toMatch(/\$\d/);
    });
  });
});
