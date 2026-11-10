import type { CookbookBrief } from '../assistant/prompt.ts';
import { libraryCookbooks } from '../library/index.ts';
import { recipes } from '../recipes/index.ts';
import type { Recipe } from '../recipes/types.ts';

/**
 * What the assistant's prompt and reply schema are built from: the recipes it
 * may add and the cookbooks it may offer. A host with its own subset passes
 * one to `buildHostPrompt` / `buildReplySchema`; the default is the planner's
 * own library.
 */
export interface PromptCatalog {
  recipes: readonly Recipe[];
  cookbooks: readonly CookbookBrief[];
}

/** Every recipe and every library cookbook, as the browser assistant sees them. */
export const defaultCatalog: PromptCatalog = {
  recipes,
  cookbooks: libraryCookbooks,
};

export type { CookbookBrief } from '../assistant/prompt.ts';
export { getLibraryCookbook, libraryCookbooks } from '../library/index.ts';
export type { LibraryCookbook } from '../library/types.ts';
export { getRecipe, recipes, recipesById } from '../recipes/index.ts';
export type { Recipe } from '../recipes/types.ts';
