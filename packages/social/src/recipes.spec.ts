import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SocialAccount,
  SocialPost,
  SocialPostAnalyticsSnapshot,
  SocialPostsRecipe,
} from './index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@happyvertical/smrt-social';

/** Fields a person must never see or be pointed at: sign-in tokens and secret names. */
const SECRET_FIELDS = [
  'accessToken',
  'refreshToken',
  'credentialSecretId',
  'accessTokenSecretName',
  'refreshTokenSecretName',
] as const;

describe('social recipes (#4409)', () => {
  it('declares Social over posts, accounts and results, leaving OAuthState out', () => {
    expect(SocialPostsRecipe.id).toBe('social.posts');
    expect(SocialPostsRecipe.label).toBe('Social');
    expect(SocialPostsRecipe.models).toEqual([
      SocialPost,
      SocialAccount,
      SocialPostAnalyticsSnapshot,
    ]);
    expect(SocialPostsRecipe.exposure).toBeUndefined();
  });

  it('hides every token and secret-name field on SocialAccount', () => {
    const fields = SocialPostsRecipe.options.SocialAccount.fields;
    for (const name of SECRET_FIELDS) {
      expect(fields[name].visibility).toBe('hidden');
    }
  });

  describe('scanned and emitted', () => {
    let manifest: ReturnType<ManifestAdapter['toManifest']>;
    let recipe: RecipeDefinition | undefined;
    let errors: string[];

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageRoot,
        include: ['src/**/*.ts'],
        exclude: [
          '**/*.spec.ts',
          '**/*.test.ts',
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
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
        packageJson: JSON.parse(
          readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
        ),
      });
      recipe = (manifest.recipes ?? []).find((r) => r.id === 'social.posts');
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits the recipe with its label and plain-words help', () => {
      expect(recipe?.label).toBe('Social');
      expect(recipe?.help?.markdown).toContain('## Overview');
      expect(recipe?.help?.fieldRefs.length).toBeGreaterThan(0);
    });

    it('exposes every nav model to the generated surface', () => {
      for (const entry of SocialPostsRecipe.nav) {
        const qualified = `${PACKAGE}:${entry.model.name}`;
        const object = manifest.objects[qualified];
        expect(object, qualified).toBeDefined();
        expect(object?.decoratorConfig.api?.include, qualified).toContain(
          'list',
        );
      }
    });

    it('never points the help at a token or secret-name field', () => {
      const markdown = recipe?.help?.markdown ?? '';
      for (const name of SECRET_FIELDS) {
        expect(markdown).not.toContain(name);
      }
      expect(recipe?.help?.fieldRefs).not.toContain(
        expect.stringMatching(/token|secret/i),
      );
    });
  });
});
