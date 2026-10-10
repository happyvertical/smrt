import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../manifest-generator.js';
import type { SmartObjectManifest } from '../types.js';

/**
 * Recipe `options` field names are validated against the MERGED manifest
 * (#3590): the scanner sees class bodies only, so STI-merged and
 * framework-base fields (`parentId`) are only knowable here.
 */
function manifestWith(
  options: RecipeDefinition['options'],
): SmartObjectManifest {
  const recipe: RecipeDefinition = {
    id: 'shop.pages',
    className: 'PagesRecipe',
    label: 'Pages',
    summary: 'Pages.',
    synonyms: [],
    models: ['@shop/pkg:Page'],
    nav: [],
    requires: [],
    options,
  };
  return {
    version: '1',
    timestamp: 0,
    packageName: '@shop/pkg',
    objects: {
      '@shop/pkg:Page': {
        className: 'Page',
        qualifiedName: '@shop/pkg:Page',
        // `parentId` is merged in from SmrtHierarchical, not the class body.
        fields: { title: { type: 'text' }, parentId: { type: 'text' } },
      },
    } as unknown as SmartObjectManifest['objects'],
    recipes: [recipe],
  };
}

describe('ManifestGenerator.assertRecipeOptions', () => {
  const generator = new ManifestGenerator();

  it('accepts merged and universal fields', () => {
    expect(() =>
      generator.assertRecipeOptions(
        manifestWith({
          '@shop/pkg:Page': {
            fields: {
              parentId: { visibility: 'advanced' },
              title: { label: 'Title' },
              slug: { visibility: 'hidden' },
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a field the model does not declare', () => {
    expect(() =>
      generator.assertRecipeOptions(
        manifestWith({
          '@shop/pkg:Page': { fields: { invented: { locked: true } } },
        }),
      ),
    ).toThrow(/Page declares no field "invented"/);
  });

  it('checks that a nav filter names a declared field', () => {
    const manifest = manifestWith(undefined);
    const [recipe] = manifest.recipes as RecipeDefinition[];
    recipe.nav = [
      {
        label: 'Open',
        model: '@shop/pkg:Page',
        key: 'open',
        filter: { field: 'title', value: 'x' },
      },
    ];
    expect(() => generator.assertRecipeOptions(manifest)).not.toThrow();
    recipe.nav[0].filter = { field: 'nope', value: 'x' };
    expect(() => generator.assertRecipeOptions(manifest)).toThrow(
      /filters on "nope"/,
    );
  });

  it('is a no-op without recipes', () => {
    expect(() =>
      generator.assertRecipeOptions({
        version: '1',
        timestamp: 0,
        objects: {},
      }),
    ).not.toThrow();
  });
});

/**
 * Recipe help refs are validated against the merged manifest too (#3591).
 */
describe('ManifestGenerator.assertRecipeHelp', () => {
  const generator = new ManifestGenerator();

  function withHelp(help: RecipeDefinition['help']): SmartObjectManifest {
    const manifest = manifestWith(undefined);
    const [recipe] = manifest.recipes as RecipeDefinition[];
    (recipe as RecipeDefinition).help = help;
    return manifest;
  }

  it('accepts merged and qualified references', () => {
    expect(() =>
      generator.assertRecipeHelp(
        withHelp({
          markdown: 'Set {field:title} and {field:Page.parentId}.',
          fieldRefs: ['Page.parentId', 'title'],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a universal field, which the knowledge artifact lacks', () => {
    expect(() =>
      generator.assertRecipeHelp(
        withHelp({ markdown: 'Set {field:slug}.', fieldRefs: ['slug'] }),
      ),
    ).toThrow(/\{field:slug\} names a field the recipe's models lack/);
  });

  it('fails the build on a reference to an undeclared field', () => {
    expect(() =>
      generator.assertRecipeHelp(
        withHelp({ markdown: 'Set {field:ghost}.', fieldRefs: ['ghost'] }),
      ),
    ).toThrow(/recipe shop\.pages: help: \{field:ghost\} names a field/);
  });

  it('fails the build when fieldRefs disagree with the markdown', () => {
    expect(() =>
      generator.assertRecipeHelp(
        withHelp({ markdown: 'Set {field:title}.', fieldRefs: [] }),
      ),
    ).toThrow(/fieldRefs does not match/);
  });

  it('fails the build on a reference to a sensitive field', () => {
    const manifest = withHelp({
      markdown: 'Enter {field:secret}.',
      fieldRefs: ['secret'],
    });
    (
      manifest.objects['@shop/pkg:Page'] as unknown as {
        fields: Record<string, unknown>;
      }
    ).fields.secret = { type: 'text', sensitive: true };
    expect(() => generator.assertRecipeHelp(manifest)).toThrow(
      /\{field:secret\} names a sensitive field/,
    );
  });

  it('is a no-op for a recipe without help', () => {
    expect(() =>
      generator.assertRecipeHelp(manifestWith(undefined)),
    ).not.toThrow();
  });
});
