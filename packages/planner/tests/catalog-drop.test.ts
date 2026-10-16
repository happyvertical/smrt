import { describe, expect, it } from 'vitest';
import { dropUnrenderableRecipes } from '../src/lib/catalog/generate/build.ts';
import type { CatalogPackage } from '../src/lib/catalog/types.ts';
import type { Recipe } from '../src/lib/recipes/types.ts';

const model = (id: string, exposed: boolean) =>
  ({ id, name: id.split(':')[1], exposed, fields: [] }) as never;
const recipe = (id: string, part: Partial<Recipe>): Recipe => ({
  id,
  label: id,
  summary: '',
  synonyms: [],
  models: [],
  nav: [],
  requires: [],
  ...part,
});
const pkg = (
  id: string,
  models: ReturnType<typeof model>[],
  recipes: Recipe[] = [],
): CatalogPackage =>
  ({
    id,
    packageName: `@happyvertical/smrt-${id}`,
    version: '1',
    description: '',
    models,
    dependencies: [],
    ...(recipes.length ? { recipes } : {}),
  }) as never;

describe('dropUnrenderableRecipes', () => {
  const log: string[] = [];
  const out = dropUnrenderableRecipes(
    [
      pkg(
        'a',
        [model('@a:One', true), model('@a:Hidden', false)],
        [
          recipe('a.ok', {
            models: ['@a:One'],
            nav: [{ model: '@a:One' } as never],
          }),
          recipe('a.hidden', {
            models: ['@a:Hidden'],
            nav: [{ model: '@a:Hidden' } as never],
          }),
          recipe('a.ghost', { models: ['@a:Gone'] }),
          recipe('a.needs', { models: ['@a:One'], requires: ['a.ghost'] }),
          recipe('a.either', {
            models: ['@a:One'],
            requiresAny: [['a.ghost', 'a.hidden']],
          }),
          recipe('a.orOk', {
            models: ['@a:One'],
            requiresAny: [['a.ghost', 'a.ok']],
          }),
        ],
      ),
      pkg(
        'b',
        [model('@b:Only', false)],
        [
          recipe('b.hidden', {
            models: ['@b:Only'],
            nav: [{ model: '@b:Only' } as never],
          }),
        ],
      ),
    ],
    (m) => log.push(m),
  );

  it('keeps what renders and drops what cannot, with a reason each', () => {
    expect(out.map((p) => p.id)).toEqual(['a']);
    expect(out[0].recipes?.map((r) => r.id)).toEqual(['a.ok', 'a.orOk']);
    expect(log.join('\n')).toContain(
      'a.either: needs one of a.ghost, a.hidden',
    );
    expect(log.join('\n')).toContain('a.hidden: opens @a:Hidden');
    expect(log.join('\n')).toContain('a.ghost: lists @a:Gone');
    expect(log.join('\n')).toContain('a.needs: needs a.ghost');
    expect(log.join('\n')).toContain('skip @happyvertical/smrt-b');
  });
});
