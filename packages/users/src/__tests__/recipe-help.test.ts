import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type HelpModel,
  helpToMarkdown,
  renderHelp,
  validateHelp,
} from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageName = '@happyvertical/smrt-users';
const recipeIds = ['users.sign-in', 'users.roles-and-permissions'];
let manifest: ReturnType<ManifestAdapter['toManifest']>;
let recipes: RecipeDefinition[];

beforeAll(async () => {
  const scanner = new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
    exclude: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/*.d.ts'],
  });
  const { results, resolved } = await scanner.scanAndResolve();
  expect(results.errors.filter((error) => error.severity === 'error')).toEqual(
    [],
  );
  manifest = new ManifestAdapter().toManifest(resolved, {
    packageName,
    typeAliases: results.typeAliases,
    recipes: results.recipes,
  });
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName,
    packageJson: JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ),
  });
  recipes = (manifest.recipes ?? []).filter((recipe) =>
    recipeIds.includes(recipe.id),
  );
});

function helpOf(recipe: RecipeDefinition) {
  if (!recipe.help) throw new Error(`Missing help for ${recipe.id}`);
  return recipe.help;
}

// The host keeps managed identity fields and sensitive values out of visitor help.
// Recipe help options may explain fields but must not make those values visible.
function modelsFor(recipe: RecipeDefinition): HelpModel[] {
  return recipe.models.map((id) => {
    const name = id.slice(id.indexOf(':') + 1);
    const object = manifest.objects[name] ?? manifest.objects[id];
    const options = recipe.options?.[name]?.fields ?? {};
    return {
      id,
      name,
      fields: Object.entries(object.fields ?? {}).map(
        ([fieldName, definition]) => ({
          name: fieldName,
          label: fieldName,
          help: options[fieldName]?.help,
          visibility:
            definition.sensitive ||
            definition._meta?.sensitive ||
            [
              'id',
              'tenantId',
              'createdAt',
              'updatedAt',
              'created_at',
              'updated_at',
            ].includes(fieldName)
              ? ('hidden' as const)
              : (options[fieldName]?.visibility ?? ('basic' as const)),
        }),
      ),
      descriptions: Object.fromEntries(
        Object.entries(object.fields ?? {})
          .filter(([, field]) => field.description)
          .map(([key, field]) => [key, field.description as string]),
      ),
    };
  });
}

describe('visitor recipe help (#3769)', () => {
  it('retains sensitive field metadata and omits those values from help', () => {
    const name = 'Session';
    const object =
      manifest.objects[name] ?? manifest.objects[`${packageName}:${name}`];
    for (const field of ['parentSessionId']) {
      expect(object.fields[field].sensitive).toBe(true);
      const recipe = recipes.find((candidate) =>
        candidate.models.includes(`${packageName}:${name}`),
      );
      if (!recipe?.help) throw new Error(`Missing help for ${name}`);
      expect(
        renderHelp(recipe.help, modelsFor(recipe), {
          showAdvanced: true,
        }).glossary.map((entry) => entry.name),
      ).not.toContain(field);
    }
  });

  it('explains every displayed scanner-emitted field without showing hidden values', () => {
    expect(recipes.map((recipe) => recipe.id).sort()).toEqual(
      [...recipeIds].sort(),
    );
    for (const recipe of recipes) {
      expect(recipe.help).toBeDefined();
      const models = modelsFor(recipe);
      expect(validateHelp(helpOf(recipe), models)).toEqual([]);
      const rendered = renderHelp(helpOf(recipe), models, {
        showAdvanced: true,
      });
      const glossary = rendered.glossary.map(
        (entry) => `${entry.model}.${entry.name}`,
      );
      for (const model of models)
        for (const field of model.fields) {
          if (field.visibility === 'hidden')
            expect(glossary).not.toContain(`${model.name}.${field.name}`);
          else
            expect(
              glossary,
              `${recipe.id}: ${model.name}.${field.name}`,
            ).toContain(`${model.name}.${field.name}`);
        }
    }
  });

  it('keeps referenced tasks visible under the default field policy', () => {
    for (const recipe of recipes) {
      const models = modelsFor(recipe);
      const rendered = renderHelp(helpOf(recipe), models);
      const glossary = rendered.glossary.map(
        (entry) => `${entry.model}.${entry.name}`,
      );
      for (const reference of helpOf(recipe).fieldRefs)
        expect(glossary).toContain(reference);
      expect(helpToMarkdown(rendered)).not.toContain('{field:');
      for (const reference of helpOf(recipe).fieldRefs) {
        const [modelName, fieldName] = reference.split('.');
        const hidden = models.map((model) => ({
          ...model,
          fields: model.fields.map((field) =>
            model.name === modelName && field.name === fieldName
              ? { ...field, visibility: 'hidden' as const }
              : field,
          ),
        }));
        expect(
          renderHelp(helpOf(recipe), hidden).glossary.map(
            (entry) => `${entry.model}.${entry.name}`,
          ),
        ).not.toContain(reference);
      }
    }
  });

  it('describes sign-in and membership tasks in visitor language', () => {
    const signIn = recipes.find((recipe) => recipe.id === 'users.sign-in');
    if (!signIn) throw new Error('Missing sign-in recipe');
    const text = helpToMarkdown(renderHelp(helpOf(signIn), modelsFor(signIn)));
    expect(helpOf(signIn).markdown).not.toMatch(/\b(API|MCP|tenant)\b/i);
    expect(text).toContain('account security');
    const roles = recipes.find(
      (recipe) => recipe.id === 'users.roles-and-permissions',
    );
    if (!roles) throw new Error('Missing roles recipe');
    expect(helpOf(roles).fieldRefs).not.toContain('Membership.tenantId');
    expect(
      helpToMarkdown(renderHelp(helpOf(roles), modelsFor(roles))),
    ).toContain('assign a role');
    for (const mode of ['hidden', 'missing']) {
      const models = modelsFor(roles).map((model) => ({
        ...model,
        fields:
          model.name !== 'Membership'
            ? model.fields
            : mode === 'missing'
              ? model.fields.filter((field) => field.name !== 'roleId')
              : model.fields.map((field) =>
                  field.name === 'roleId'
                    ? { ...field, visibility: 'hidden' as const }
                    : field,
                ),
      }));
      expect(helpToMarkdown(renderHelp(helpOf(roles), models))).not.toContain(
        'assign a role',
      );
    }
  });
});
