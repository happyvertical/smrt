import type { Cookbook } from '../cookbook/types.ts';
import { holdsCookbook } from '../library/apply.ts';
import { libraryCookbooks } from '../library/index.ts';
import type { LibraryCookbook } from '../library/types.ts';

/** The shell's brand label when nothing names the app. */
export const DEFAULT_PLANNER_TITLE = 'Planner';

/** What the title derivation reads of the cookbook document. */
export type TitledCookbook = Pick<Cookbook, 'name' | 'recipes' | 'features'>;

/**
 * The app's title, for the shell brand and the page `<title>`: an explicit
 * app name (`set_name`, carried in the cookbook document) wins; else the
 * library cookbook the visitor applied and still holds (its friendly `name`,
 * never its id); else "Planner". A reset, a replacing import or removing the
 * cookbook's recipes drops the library name the same way the Cookbooks tab
 * stops marking it "in use".
 */
export function plannerTitle(
  cookbook: TitledCookbook,
  applied: string | null | undefined,
  library: readonly LibraryCookbook[] = libraryCookbooks,
): string {
  const name = cookbook.name?.trim();
  if (name) return name;
  const entry = applied ? library.find((c) => c.id === applied) : undefined;
  if (entry && holdsCookbook(entry, cookbook)) return entry.name;
  return DEFAULT_PLANNER_TITLE;
}
