import { recipesById } from '../recipes/index.ts';
import raw from './library.json' with { type: 'json' };
import type { LibraryCookbook, LibraryFile } from './types.ts';

export { COOKBOOK_ICONS } from './icons.ts';
export type * from './types.ts';

/** Cookbook names in alphabetical order, the same in every runtime. */
const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * The curated cookbooks, alphabetical by name: the order the Cookbooks tab,
 * the assistant, the command catalog and the MCP widget all list them in.
 */
export const libraryCookbooks: readonly LibraryCookbook[] = [
  ...(raw as unknown as LibraryFile).cookbooks,
].sort((a, b) => byName.compare(a.name, b.name));

export function getLibraryCookbook(id: string): LibraryCookbook | undefined {
  return libraryCookbooks.find((cookbook) => cookbook.id === id);
}

/** Recipe labels for the preview's chips, in the cookbook's (sorted) order. */
export function libraryRecipeLabels(cookbook: LibraryCookbook): string[] {
  return cookbook.document.recipes.map(
    (id) => recipesById.get(id)?.label ?? id,
  );
}
