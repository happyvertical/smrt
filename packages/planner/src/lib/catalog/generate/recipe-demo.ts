import { effectiveRecipeDemo } from '@happyvertical/smrt-core/recipe-demo';
import type { Recipe } from '../../recipes/types.ts';
import type { CatalogPackage } from '../types.ts';

/**
 * Adds `effectiveDemo` to every recipe whose browser-demo answer changes once
 * what it requires is counted: the worst mode of its own `demo` and of every
 * recipe it needs, across packages (smrt#3709). The rule is smrt-core's
 * `effectiveRecipeDemo`, not a copy: it runs here, in the node-side
 * generator, because core is not safe to import into the browser bundle. A
 * recipe whose own `demo` already is its effective one gets no key, and a
 * recipe with no `demo` gets none (nothing was measured).
 */
export function withEffectiveDemo(
  packages: readonly CatalogPackage[],
): CatalogPackage[] {
  const all: Recipe[] = packages.flatMap((pkg) => pkg.recipes ?? []);
  return packages.map((pkg) => {
    if (!pkg.recipes) return pkg;
    return {
      ...pkg,
      recipes: pkg.recipes.map((recipe) => {
        const effective = effectiveRecipeDemo(recipe.id, all);
        if (
          !effective ||
          !recipe.demo ||
          JSON.stringify(effective) === JSON.stringify(recipe.demo)
        ) {
          return recipe;
        }
        return { ...recipe, effectiveDemo: effective };
      }),
    };
  });
}
