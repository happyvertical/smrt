import { isShellLayoutEmpty } from '@happyvertical/smrt-svelte/workspace/layout';
import type { Cookbook, CookbookResult } from '../cookbook/types.ts';
import { type AppSettings, writeSettings } from '../settings/app-settings.ts';
import type { LibraryCookbook } from './types.ts';

/*
 * The parts of applying a library cookbook that need no browser and no
 * validator import: `apply.ts` (the browser store) and the headless planner
 * both build on them.
 */

/** Nothing built yet: no recipes, features, saved options, narrowing, layout or theme. */
export function isCookbookEmpty(cookbook: Cookbook): boolean {
  return (
    cookbook.recipes.length === 0 &&
    cookbook.features.length === 0 &&
    cookbook.policies.length === 0 &&
    Object.keys(cookbook.exposure ?? {}).length === 0 &&
    cookbook.theme === undefined &&
    isShellLayoutEmpty(cookbook.layout)
  );
}

/**
 * The document a library cookbook sets up, through the given strict check
 * (`parseCookbook` in the browser). `settings` are the visitor's edits of the
 * cookbook's starting values; the cookbook's own data is never changed
 * (writeSettings returns a copy).
 */
export function resolveLibraryCookbook(
  cookbook: LibraryCookbook,
  parse: (input: unknown) => CookbookResult,
  settings?: AppSettings,
): CookbookResult {
  return parse(
    settings
      ? writeSettings(structuredClone(cookbook.document), settings)
      : cookbook.document,
  );
}
