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
import { AnalyticsReportsRecipe } from '../index.js';
import { AnalyticsProperty } from '../models/AnalyticsProperty.js';
import { AnalyticsReport } from '../models/AnalyticsReport.js';
import { AnalyticsReportsRecipe as FromRecipes } from '../recipes.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-analytics';

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

describe('analytics recipes (#3719)', () => {
  it('is exported from the package entry', () => {
    expect(AnalyticsReportsRecipe).toBe(FromRecipes);
  });

  it('declares analytics.reports over properties and reports', () => {
    expect(AnalyticsReportsRecipe.id).toBe('analytics.reports');
    expect(AnalyticsReportsRecipe.models).toEqual([
      AnalyticsProperty,
      AnalyticsReport,
    ]);
    expect(AnalyticsReportsRecipe.nav.map((entry) => entry.model)).toEqual([
      AnalyticsProperty,
      AnalyticsReport,
    ]);
    expect(AnalyticsReportsRecipe.requires).toEqual([]);
  });

  it('runs on the server: storage, AI summaries and provider credentials', () => {
    expect(AnalyticsReportsRecipe.runtime).toBe('server');
  });

  describe('route surface', () => {
    const [surface] = AnalyticsReportsRecipe.surfaces;

    it('names a component the svelte entry really exports', () => {
      expect(AnalyticsReportsRecipe.surfaces).toHaveLength(1);
      expect(surface.kind).toBe('route');
      const [specifier, exportName] = surface.export.split('#');
      expect(specifier).toBe(`${PACKAGE}/svelte`);
      const svelteIndex = readFileSync(
        resolve(packageRoot, 'src/svelte/index.ts'),
        'utf-8',
      );
      expect(svelteIndex).toMatch(
        new RegExp(`export \\{[^}]*\\b${exportName}\\b[^}]*\\}`),
      );
      const packageJson = JSON.parse(
        readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
      );
      expect(packageJson.exports['./svelte']).toBeDefined();
    });

    it('only routes a component that renders without row data', () => {
      const component = readFileSync(
        resolve(packageRoot, 'src/svelte/AnalyticsSummary.svelte'),
        'utf-8',
      );
      expect(component).toContain('{#if stats}');
    });
  });

  describe('scanner validation and manifest emission', () => {
    let built: Awaited<ReturnType<typeof buildManifest>>;
    beforeAll(async () => {
      built = await buildManifest();
    });

    it('scans without errors and passes the generation checks', () => {
      expect(built.errors).toEqual([]);
    });

    it('emits one recipe with qualified models, nav, route and runtime', () => {
      expect(built.recipes).toHaveLength(1);
      const [recipe] = built.recipes;
      expect(recipe.id).toBe('analytics.reports');
      expect(recipe.className).toBe('AnalyticsReportsRecipe');
      expect(recipe.models).toEqual([
        `${PACKAGE}:AnalyticsProperty`,
        `${PACKAGE}:AnalyticsReport`,
      ]);
      expect(recipe.nav.map((entry) => entry.model)).toEqual(recipe.models);
      expect(recipe.runtime).toBe('server');
      expect(recipe.surfaces).toEqual([
        {
          kind: 'route',
          path: '/analytics/summary',
          export: `${PACKAGE}/svelte#AnalyticsSummary`,
          label: 'Traffic summary',
        },
      ]);
      expect(recipe).not.toHaveProperty('providers');
      expect(recipe).not.toHaveProperty('demoSeed');
    });

    it('keeps secrets out of the emitted options and help references', () => {
      const [recipe] = built.recipes;
      const emitted = JSON.stringify(recipe);
      expect(emitted).not.toContain('apiSecret');
      expect(emitted).not.toContain('providerMetadata');
    });

    it('emits the help with the references the Markdown makes', () => {
      const [recipe] = built.recipes;
      const help = helpOf(recipe);
      expect(help.markdown).toContain('## Overview');
      expect(help.markdown).toContain('## Tasks');
      expect(help.fieldRefs).toEqual(extractFieldRefs(help.markdown));
      expect(help.fieldRefs).toContain('AnalyticsReport.metrics');
    });

    describe('help rendering', () => {
      const models = (): HelpModel[] => {
        const [recipe] = built.recipes;
        const hidden = new Set(
          Object.entries(recipe.options ?? {}).flatMap(([model, options]) =>
            Object.entries(options.fields ?? {})
              .filter(([, policy]) => policy.visibility !== undefined)
              .map(([name, policy]) => `${model}.${name}:${policy.visibility}`),
          ),
        );
        return recipe.models.map((id) => {
          const name = id.slice(id.indexOf(':') + 1);
          const object =
            built.manifest.objects[id] ?? built.manifest.objects[name];
          const fields = Object.entries(object.fields ?? {}) as Array<
            [string, { description?: string }]
          >;
          return {
            id,
            name,
            fields: fields.map(([field]) => ({
              name: field,
              label: field,
              visibility: hidden.has(`${name}.${field}:hidden`)
                ? ('hidden' as const)
                : hidden.has(`${name}.${field}:advanced`)
                  ? ('advanced' as const)
                  : ('basic' as const),
            })),
            descriptions: Object.fromEntries(
              fields
                .filter(([, def]) => def.description)
                .map(([field, def]) => [field, def.description as string]),
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
        const help = helpOf(recipe);
        const rendered = renderHelp(help, models());
        const markdown = helpToMarkdown(rendered);
        expect(markdown).not.toContain('{field:');
        expect(markdown).toContain('reports.query');
        expect(markdown).toContain('reports.runtime.define');
        const glossary = rendered.glossary.map(
          (entry) => `${entry.model}.${entry.name}`,
        );
        // A foreign key carries no description, so the glossary skips it.
        for (const ref of help.fieldRefs.filter(
          (name) => name !== 'AnalyticsReport.propertyId',
        )) {
          expect(glossary, ref).toContain(ref);
        }
      });
    });
  });

  describe('user-facing help (#3591)', () => {
    const markdown = () =>
      readFileSync(
        resolve(packageRoot, 'src', AnalyticsReportsRecipe.help),
        'utf-8',
      );

    it('points at a help file beside recipes.ts', () => {
      expect(AnalyticsReportsRecipe.help).toBe('./reports.recipe.md');
      expect(markdown()).toContain('## Overview');
    });

    it('relates saved reports to declared and runtime reports', () => {
      expect(markdown()).toContain('`reports.query`');
      expect(markdown()).toContain('`reports.runtime.define`');
      expect(markdown()).toContain('Nothing is saved until you');
    });
  });
});
