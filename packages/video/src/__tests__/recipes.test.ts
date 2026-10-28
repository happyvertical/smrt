import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Character,
  Scene,
  VideoComposition,
  VideoLibraryRecipe,
  VideoSequence,
  VideoShot,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-video';

describe('video recipes (#4409)', () => {
  it('declares Video over the planning models, fully editable', () => {
    expect(VideoLibraryRecipe.id).toBe('video.library');
    expect(VideoLibraryRecipe.label).toBe('Video');
    expect(VideoLibraryRecipe.models).toEqual([
      VideoComposition,
      VideoSequence,
      VideoShot,
      Character,
      Scene,
    ]);
    expect(VideoLibraryRecipe.exposure).toBeUndefined();
    expect(VideoLibraryRecipe.section.id).toBe('publish');
    expect(VideoLibraryRecipe.nav.map((entry) => entry.label)).toEqual([
      'Videos',
      'Sequences',
      'Shots',
      'Characters',
      'Scenes',
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
      // The build derives this from the dependency tree; it lets the generator
      // merge the Content fields the three STI models inherit, the same way the
      // shipped manifest.json carries them, so `options` can curate them.
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
        Object.entries(manifest.objects)
          .filter(([, object]) => {
            const api = object.decoratorConfig?.api;
            if (api === false) return false;
            if (api === true || api === undefined) return true;
            const include = (api as { include?: string[] }).include;
            return !include || include.includes('list');
          })
          .map(([name]) => name.split(':').pop() ?? name),
      );
    });

    it('passes scanner validation and the merged-manifest field checks', () => {
      expect(errors).toEqual([]);
    });

    it('emits the recipe with its label and plain-words help', () => {
      const recipe = recipes.find((entry) => entry.id === 'video.library');
      expect(recipe?.label).toBe('Video');
      expect(recipe?.exposure).toBeUndefined();
      expect(recipe?.help?.markdown).toContain('## Tasks');
      expect(recipe?.help?.fieldRefs?.length).toBeGreaterThan(0);
      expect(recipe?.help?.fieldRefs).toContain('VideoShot.scriptText');
    });

    it('lists every nav model on the generated surface', () => {
      const recipe = recipes.find((entry) => entry.id === 'video.library');
      for (const entry of recipe?.nav ?? []) {
        const model = entry.model.split(':').pop();
        expect(exposedModels.has(model ?? ''), model).toBe(true);
      }
    });
  });
});
