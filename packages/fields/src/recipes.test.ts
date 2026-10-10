import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFieldRefs,
  helpToMarkdown,
  ManifestGenerator,
  renderHelp,
} from '@happyvertical/smrt-core';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { FormCustomizationRecipe } from './index.js';
import { FieldPolicy } from './models/FieldPolicy.js';
import { FieldPolicySuggestion } from './models/FieldPolicySuggestion.js';
import { FieldUsageCounter } from './models/FieldUsageCounter.js';
import { FieldUsageReportReceipt } from './models/FieldUsageReportReceipt.js';
import { FormCustomizationRecipe as FromRecipes } from './recipes.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@happyvertical/smrt-fields';

describe('fields recipes (#3719)', () => {
  it('is exported from the package entry', () => {
    expect(FormCustomizationRecipe).toBe(FromRecipes);
  });

  it('declares fields.form-customization over the policy tables', () => {
    expect(FormCustomizationRecipe.id).toBe('fields.form-customization');
    expect(FormCustomizationRecipe.models).toEqual([
      FieldPolicy,
      FieldPolicySuggestion,
      FieldUsageCounter,
      FieldUsageReportReceipt,
    ]);
    expect(FormCustomizationRecipe.requires).toEqual([]);
  });

  describe('scanner validation and manifest emission', () => {
    let recipe: RecipeDefinition;
    let errors: string[];
    let emitted: RecipeDefinition[];

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageDir,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      errors = results.errors.map((error) => error.message);
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: PACKAGE,
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
      });
      emitted = (manifest.recipes ?? []) as RecipeDefinition[];
      recipe = emitted.find(
        (entry) => entry.id === 'fields.form-customization',
      ) as RecipeDefinition;
    });

    it('scans without errors and emits exactly one recipe', () => {
      expect(errors).toEqual([]);
      expect(emitted.map((entry) => entry.id)).toEqual([
        'fields.form-customization',
      ]);
    });

    it('qualifies the model names', () => {
      expect(recipe.models).toEqual([
        `${PACKAGE}:FieldPolicy`,
        `${PACKAGE}:FieldPolicySuggestion`,
        `${PACKAGE}:FieldUsageCounter`,
        `${PACKAGE}:FieldUsageReportReceipt`,
      ]);
      expect(recipe.nav).toEqual([]);
    });

    it('emits the settings panel at the real /svelte export, server runtime', () => {
      expect(recipe.surfaces).toEqual([
        {
          kind: 'settings-panel',
          export: `${PACKAGE}/svelte#FieldPolicyControlPanel`,
          label: 'Form defaults',
        },
      ]);
      expect(recipe.runtime).toBe('server');
      expect(recipe.providers).toBeUndefined();
      expect(recipe.demoSeed).toBeUndefined();
    });

    it('emits help whose fieldRefs match the Markdown', () => {
      expect(recipe.help?.markdown).toBe(markdown());
      expect(recipe.help?.fieldRefs).toEqual(
        [...new Set(extractFieldRefs(markdown()))].sort(),
      );
    });
  });

  describe('surface target', () => {
    it('names a component the /svelte entry really exports', () => {
      const source = readFileSync(
        join(packageDir, 'src/svelte/index.ts'),
        'utf-8',
      );
      const surface = FormCustomizationRecipe.surfaces[0];
      const [specifier, name] = surface.export.split('#');
      expect(specifier).toBe(`${PACKAGE}/svelte`);
      expect(source).toMatch(
        new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\}`, 's'),
      );
      const pkg = JSON.parse(
        readFileSync(join(packageDir, 'package.json'), 'utf-8'),
      );
      expect(pkg.exports['./svelte']).toBeDefined();
    });
  });

  describe('user-facing help (#3591)', () => {
    it('points at a help file beside recipes.ts', () => {
      expect(FormCustomizationRecipe.help).toBe(
        './form-customization.recipe.md',
      );
      expect(markdown()).toContain('## Overview');
      expect(markdown()).toContain('## Tasks');
    });

    it('names only fields FieldPolicy declares, each with a description', () => {
      const declared = new Set(Object.keys(new FieldPolicy()));
      const refs = extractFieldRefs(markdown());
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(declared.has(ref), ref).toBe(true);
    });

    const policyModel = (
      visibility: Record<string, 'basic' | 'advanced' | 'hidden'> = {},
    ) => {
      const names = [...new Set(extractFieldRefs(markdown()))];
      const descriptions = Object.fromEntries(
        names.map((name) => [name, `About ${name}.`]),
      );
      return [
        {
          id: `${PACKAGE}:FieldPolicy`,
          name: 'FieldPolicy',
          fields: names.map((name) => ({
            name,
            label: `Label of ${name}`,
            visibility: visibility[name] ?? 'basic',
          })),
          descriptions,
        },
      ];
    };

    it('renders labels in place of references and lists a glossary', () => {
      const rendered = renderHelp(
        { markdown: markdown(), fieldRefs: extractFieldRefs(markdown()) },
        policyModel(),
      );
      const flat = helpToMarkdown(rendered);
      expect(flat).not.toContain('{field:');
      expect(flat).toContain('Label of visibility');
      expect(rendered.glossary.map((entry) => entry.name).sort()).toEqual(
        [...new Set(extractFieldRefs(markdown()))].sort(),
      );
    });

    it('drops steps tied to a hidden field', () => {
      const rendered = renderHelp(
        { markdown: markdown(), fieldRefs: extractFieldRefs(markdown()) },
        policyModel({ locked: 'hidden' }),
      );
      const flat = helpToMarkdown(rendered);
      expect(flat).not.toContain('Label of locked');
      expect(rendered.glossary.some((entry) => entry.name === 'locked')).toBe(
        false,
      );
    });
  });
});

function markdown(): string {
  return readFileSync(
    join(packageDir, 'src', FormCustomizationRecipe.help),
    'utf-8',
  );
}
