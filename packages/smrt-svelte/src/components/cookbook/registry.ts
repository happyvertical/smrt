/**
 * The widget registry of a cookbook app's section pages (#3749): the core
 * widgets (a shortcuts loader that reads the shell's resolved sections, plus
 * whatever data loaders the host injects) and the recipes' `widget` surfaces.
 */

import {
  type RecipeExportResolver,
  type RecipeWidgetRegistration,
  type RecipeWidgetSource,
  registerRecipeWidgets,
} from '../overview/recipe-widgets.js';
import {
  createWidgetRegistry,
  type WidgetRegistry,
} from '../overview/registry.js';
import type { WidgetLoadContext } from '../overview/types.js';
import {
  type CoreWidgetLoaders,
  registerCoreWidgets,
} from '../overview/widgets/core.js';
import {
  type ShortcutNavSection,
  type ShortcutsWidgetData,
  shortcutsFromNav,
} from '../overview/widgets/data.js';

/** What a section page hands its widgets' loaders besides the host's own context. */
export interface CookbookWidgetContext {
  /** The shell's resolved sections (renames, hides and moves applied). */
  sections: readonly ShortcutNavSection[];
}

/**
 * `shortcuts`: the section's menu entries as cards, as the shell resolves
 * them. `section` names another section by its id without the `section:` /
 * `custom:` prefix; absent, the overview's own section.
 */
export function loadShortcuts(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
): ShortcutsWidgetData {
  const { sections } = ctx as WidgetLoadContext &
    Partial<CookbookWidgetContext>;
  if (!sections) throw new Error('the cookbook widget context is missing');
  const named = typeof options.section === 'string' ? options.section : '';
  const sectionId = named
    ? sections.find(
        (s) => s.id === `section:${named}` || s.id === `custom:${named}`,
      )?.id
    : ctx.overviewId;
  if (!sectionId) throw new Error(`unknown section ${named}`);
  return shortcutsFromNav(sections, sectionId);
}

export interface CookbookRegistryOptions {
  /** Data loaders for `metric`, `records` and `chart` (omitted ones are not registered). */
  loaders?: Omit<CoreWidgetLoaders, 'shortcuts'>;
  /** Recipes whose `widget` surfaces to register. */
  widgets?: readonly RecipeWidgetSource[];
  /** The host's module resolver for recipe exports. */
  resolveExport?: RecipeExportResolver;
}

export interface CookbookRegistry {
  registry: WidgetRegistry;
  /** Recipe widgets registered or skipped, for diagnostics. */
  recipeWidgets: RecipeWidgetRegistration | null;
}

/** An isolated registry for one cookbook app. */
export async function createCookbookRegistry(
  options: CookbookRegistryOptions = {},
): Promise<CookbookRegistry> {
  const registry = createWidgetRegistry();
  registerCoreWidgets(registry, {
    ...options.loaders,
    shortcuts: loadShortcuts,
  });
  const recipeWidgets =
    options.widgets && options.widgets.length > 0 && options.resolveExport
      ? await registerRecipeWidgets(
          registry,
          options.widgets,
          options.resolveExport,
        )
      : null;
  return { registry, recipeWidgets };
}
