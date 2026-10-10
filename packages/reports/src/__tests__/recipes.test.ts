import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFieldRefs,
  type HelpModel,
  helpToMarkdown,
  renderHelp,
  validateHelp,
} from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type {
  RecipeDefinition,
  RecipeHelp,
  SmartObjectManifest,
} from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { MaterializedReportsRecipe } from '../index.js';
import { MaterializedReportsRecipe as FromRecipes } from '../recipes.js';
import {
  SmrtPrincipalReportRefreshTask,
  SmrtReportRefreshTask,
} from '../scheduler.js';
import {
  SmrtReportLock,
  SmrtReportRun,
  SmrtReportSchedule,
  SmrtReportWatermark,
} from '../state.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-reports';

function helpOf(recipe: RecipeDefinition): RecipeHelp {
  if (!recipe.help) throw new Error(`${recipe.id} emitted no help`);
  return recipe.help;
}

/**
 * Run the real scan -> manifest -> generation-pass pipeline in memory (no
 * files written), so the recipe is checked exactly as a build would check it.
 */
async function buildManifest(): Promise<{
  manifest: SmartObjectManifest;
  recipes: RecipeDefinition[];
  errors: string[];
}> {
  const scanner = new OxcScanner({
    cwd: packageRoot,
    include: ['src/**/*.ts'],
    exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
  });
  const { results, resolved } = await scanner.scanAndResolve();
  const errors = results.errors
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => `${diagnostic.filePath}: ${diagnostic.message}`);
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: PACKAGE,
    typeAliases: results.typeAliases,
    recipes: results.recipes,
  });
  const packageJson = JSON.parse(
    readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
  );
  // Throws when options or help name a field the merged models lack.
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: PACKAGE,
    packageJson,
  });
  return { manifest, recipes: manifest.recipes ?? [], errors };
}

describe('reports recipes (#3719)', () => {
  it('is exported from the package entry', () => {
    expect(MaterializedReportsRecipe).toBe(FromRecipes);
  });

  it('declares reports.materialized over the refresh bookkeeping tables', () => {
    expect(MaterializedReportsRecipe.id).toBe('reports.materialized');
    expect(MaterializedReportsRecipe.models).toEqual([
      SmrtReportRun,
      SmrtReportWatermark,
      SmrtReportLock,
      SmrtReportSchedule,
      SmrtReportRefreshTask,
      SmrtPrincipalReportRefreshTask,
    ]);
    expect(MaterializedReportsRecipe.requires).toEqual([]);
  });

  it('runs on the server only: aggregation is SQL and refresh is queued', () => {
    expect(MaterializedReportsRecipe.runtime).toBe('server');
  });

  describe('scanner validation and manifest emission', () => {
    let built: Awaited<ReturnType<typeof buildManifest>>;
    beforeAll(async () => {
      built = await buildManifest();
    });

    it('scans without errors and passes the generation checks', () => {
      expect(built.errors).toEqual([]);
    });

    it('emits one recipe with qualified models, no nav and no surfaces', () => {
      expect(built.recipes).toHaveLength(1);
      const [recipe] = built.recipes;
      expect(recipe.id).toBe('reports.materialized');
      expect(recipe.className).toBe('MaterializedReportsRecipe');
      expect(recipe.models).toEqual(
        [
          'SmrtReportRun',
          'SmrtReportWatermark',
          'SmrtReportLock',
          'SmrtReportSchedule',
          'SmrtReportRefreshTask',
          'SmrtPrincipalReportRefreshTask',
        ].map((name) => `${PACKAGE}:${name}`),
      );
      expect(recipe.nav).toEqual([]);
      expect(recipe.requires).toEqual([]);
      expect(recipe.runtime).toBe('server');
      expect(recipe).not.toHaveProperty('surfaces');
      expect(recipe).not.toHaveProperty('providers');
      expect(recipe).not.toHaveProperty('demoSeed');
    });

    it('emits the help with the references the Markdown makes', () => {
      const [recipe] = built.recipes;
      expect(recipe.help?.markdown).toContain('## Overview');
      expect(recipe.help?.markdown).toContain('## Tasks');
      expect(recipe.help?.fieldRefs).toEqual(
        extractFieldRefs(recipe.help?.markdown ?? ''),
      );
      expect(recipe.help?.fieldRefs).toContain('SmrtReportSchedule.cron');
    });

    describe('help rendering', () => {
      const models = (): HelpModel[] => {
        const [recipe] = built.recipes;
        return recipe.models.map((id) => {
          const object =
            built.manifest.objects[id.slice(id.indexOf(':') + 1)] ??
            built.manifest.objects[id];
          const fields = Object.entries(object.fields ?? {}) as Array<
            [string, { description?: string }]
          >;
          return {
            id,
            name: id.slice(id.indexOf(':') + 1),
            fields: fields.map(([name]) => ({
              name,
              label: name,
              visibility: 'basic' as const,
            })),
            descriptions: Object.fromEntries(
              fields
                .filter(([, def]) => def.description)
                .map(([name, def]) => [name, def.description as string]),
            ),
          };
        });
      };

      it('names only fields the models declare', () => {
        const [recipe] = built.recipes;
        expect(validateHelp(helpOf(recipe), models())).toEqual([]);
      });

      it('renders every task and explains each field it names', () => {
        const [recipe] = built.recipes;
        const rendered = renderHelp(helpOf(recipe), models());
        const markdown = helpToMarkdown(rendered);
        expect(markdown).not.toContain('{field:');
        expect(markdown).toContain('reports.query');
        expect(markdown).toContain('reports.runtime.define');
        const glossary = rendered.glossary.map(
          (entry) => `${entry.model}.${entry.name}`,
        );
        for (const ref of helpOf(recipe).fieldRefs) {
          expect(glossary, ref).toContain(ref);
        }
      });
    });
  });

  describe('user-facing help (#3591)', () => {
    const markdown = () =>
      readFileSync(
        resolve(packageRoot, 'src', MaterializedReportsRecipe.help),
        'utf-8',
      );

    it('points at a help file beside recipes.ts', () => {
      expect(MaterializedReportsRecipe.help).toBe('./materialized.recipe.md');
      expect(markdown()).toContain('## Overview');
    });

    it('relates declared reports to the runtime report tools', () => {
      expect(markdown()).toContain('reports.query');
      expect(markdown()).toContain('reports.runtime.sources');
      expect(markdown()).toContain('never stored');
    });
  });
});
