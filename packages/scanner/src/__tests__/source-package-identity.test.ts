import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';

// #5655: a class compiled from another package's source is qualified by its
// owner, and a recipe naming it must follow the same identity.
describe('owner package identity in toManifest', () => {
  const classDef = (className: string, filePath: string) =>
    ({
      className,
      filePath,
      fields: [],
      allFields: [],
      methods: [],
      decoratorConfig: {},
    }) as never;

  it('qualifies classes and recipe model references by owner package', () => {
    const manifest = new ManifestAdapter().toManifest(
      [
        classDef('Portfolio', '/r/packages/work/src/Portfolio.ts'),
        classDef('Note', '/r/apps/web/src/Note.ts'),
      ],
      {
        packageName: '@fixture/web',
        packageNameForFile: (file) =>
          file.includes('/packages/work/') ? '@fixture/work' : undefined,
        recipes: [
          {
            models: ['Portfolio', 'Note'],
            nav: [{ model: 'Portfolio' }],
            options: { Portfolio: {} },
          },
        ] as never,
      },
    );
    expect(Object.keys(manifest.objects).sort()).toEqual([
      '@fixture/web:Note',
      '@fixture/work:Portfolio',
    ]);
    const [recipe] = manifest.recipes ?? [];
    expect(recipe.models).toEqual([
      '@fixture/work:Portfolio',
      '@fixture/web:Note',
    ]);
    expect(recipe.nav[0].model).toBe('@fixture/work:Portfolio');
    expect(Object.keys(recipe.options ?? {})).toEqual([
      '@fixture/work:Portfolio',
    ]);
  });
});
