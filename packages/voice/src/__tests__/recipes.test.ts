import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  VoiceOutput,
  VoiceProfile,
  VoiceProfilesRecipe,
  VoiceSample,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-voice';

describe('voice recipes (#4409)', () => {
  it('declares Voice over the profile, sample and output models', () => {
    expect(VoiceProfilesRecipe.id).toBe('voice.profiles');
    expect(VoiceProfilesRecipe.label).toBe('Voice');
    expect(VoiceProfilesRecipe.models).toEqual([
      VoiceProfile,
      VoiceSample,
      VoiceOutput,
    ]);
    expect(VoiceProfilesRecipe.exposure).toBeUndefined();
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
      // The build derives this from the dependency tree; it lets the generator
      // merge the Content fields VoiceOutput inherits from smrt-content, the
      // same way the shipped manifest.json carries them.
      manifest.smrtDependencies = [
        '@happyvertical/smrt-core',
        '@happyvertical/smrt-content',
      ];
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
        packageJson: JSON.parse(
          readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
        ),
      });
      recipes = manifest.recipes ?? [];
      exposedModels = new Set(
        Object.values(manifest.objects)
          .filter((object) => {
            const api = object.decoratorConfig?.api;
            const mcp = object.decoratorConfig?.mcp;
            const hasList = (surface: unknown) =>
              surface === true ||
              (typeof surface === 'object' &&
                surface !== null &&
                Array.isArray((surface as { include?: unknown }).include) &&
                (surface as { include: string[] }).include.includes('list'));
            return hasList(api) || hasList(mcp);
          })
          .map((object) => object.className),
      );
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits the Voice recipe with plain-words help tied to its fields', () => {
      const recipe = recipes.find((entry) => entry.id === 'voice.profiles');
      expect(recipe?.label).toBe('Voice');
      expect(recipe?.help?.markdown).toContain('## Tasks');
      expect(recipe?.help?.fieldRefs?.length).toBeGreaterThan(0);
      expect(recipe?.exposure).toBeUndefined();
    });

    it('exposes every nav model to the generated surface', () => {
      for (const entry of VoiceProfilesRecipe.nav) {
        expect(exposedModels.has(entry.model.name)).toBe(true);
      }
    });
  });
});
