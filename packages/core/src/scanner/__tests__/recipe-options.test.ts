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
