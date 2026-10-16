import { recipesById } from '../recipes/index.ts';
import raw from './library.json' with { type: 'json' };
import type { LibraryCookbook, LibraryFile } from './types.ts';

export { COOKBOOK_ICONS } from './icons.ts';
export type * from './types.ts';

/** The curated cookbooks, in the order the tab shows them. */
export const libraryCookbooks: readonly LibraryCookbook[] = (
  raw as unknown as LibraryFile
).cookbooks;

export function getLibraryCookbook(id: string): LibraryCookbook | undefined {
  return libraryCookbooks.find((cookbook) => cookbook.id === id);
}

/** Recipe labels for the preview's chips, in the cookbook's (sorted) order. */
export function libraryRecipeLabels(cookbook: LibraryCookbook): string[] {
  return cookbook.document.recipes.map(
    (id) => recipesById.get(id)?.label ?? id,
  );
}
