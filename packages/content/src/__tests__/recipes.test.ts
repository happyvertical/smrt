import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Article,
  ArticlesRecipe,
  Content,
  ContentContribution,
  ContentContributor,
  ContentCorrection,
  ContentReview,
  ContentVersion,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-content';

describe('content recipes (#4409)', () => {
  it('declares Articles over the exposed Content base and its records', () => {
    expect(ArticlesRecipe.id).toBe('content.articles');
    expect(ArticlesRecipe.label).toBe('Articles');
    expect(ArticlesRecipe.models).toEqual([
      Content,
      ContentVersion,
      ContentCorrection,
      ContentReview,
      ContentContribution,
      ContentContributor,
    ]);
    expect(ArticlesRecipe.exposure).toBeUndefined();
    expect(ArticlesRecipe.section.id).toBe('publish');
  });

  it('narrows the Articles entry to article content instead of the closed Article subclass', () => {
    const articles = ArticlesRecipe.nav.find(
      (entry) => entry.key === 'articles',
    );
    expect(articles?.model).toBe(Content);
    expect(articles?.filter).toEqual({ field: 'type', value: 'article' });
    expect(ArticlesRecipe.models).not.toContain(Article);
    expect(new Content({ type: 'article' }).type).toBe(articles?.filter?.value);
  });

  describe('scanned and emitted', () => {
    let recipes: RecipeDefinition[];
    let errors: string[];
    let exposed: Set<string>;

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageRoot,
        include: ['src/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/*.spec.ts',
          '**/__tests__/**',
          '**/*.d.ts',
          'src/svelte/**',
          'src/routes/**',
        ],
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
      exposed = new Set(
        Object.values(manifest.objects ?? {})
          .filter((object) => {
            const api = object.decoratorConfig?.api;
            if (api === false) return false;
            if (api === true || api === undefined) return true;
            const include = (api as { include?: string[] }).include;
            return !include || include.includes('list');
          })
          .map((object) => object.qualifiedName ?? object.className),
      );
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits Articles with its label and plain-words help', () => {
      const recipe = recipes.find((entry) => entry.id === 'content.articles');
      expect(recipe?.label).toBe('Articles');
      expect(recipe?.help?.markdown).toContain('## Tasks');
      expect(recipe?.help?.fieldRefs?.length).toBeGreaterThan(0);
      expect(recipe?.help?.fieldRefs).toContain('Content.title');
    });

    it('lists only models the generated surface exposes in nav', () => {
      const recipe = recipes.find((entry) => entry.id === 'content.articles');
      expect(recipe).toBeDefined();
      for (const entry of recipe?.nav ?? []) {
        expect(exposed.has(entry.model), `${entry.model} is exposed`).toBe(
          true,
        );
      }
    });
  });
});
