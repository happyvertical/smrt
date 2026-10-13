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
import type { WidgetLoad, WidgetLoadContext } from '../overview/types.js';
import { registerCoreWidgets } from '../overview/widgets/core.js';
import {
  type ShortcutEntry,
  type ShortcutNavSection,
  type ShortcutsWidgetData,
  shortcutsFromNav,
} from '../overview/widgets/data.js';
import type { CookbookLoaders, CookbookShortcutsLoader } from './types.js';

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

/**
 * The registry's shortcuts loader composed with a host's (#3888): the default
 * entries come from the shell's sections as in {@link loadShortcuts}; the host
 * loader receives them and returns the entries to show (counts, reorders,
 * additions). Without a host loader this is `loadShortcuts`. A host loader
 * that throws (or returns something that is not an entry list) leaves the
 * defaults in place for that load, so a failed count query never empties the
 * page; an aborted load still rejects.
 */
export function composeShortcutsLoader(
  host?: CookbookShortcutsLoader,
): WidgetLoad<ShortcutsWidgetData> {
  if (!host) return loadShortcuts;
  return async (options, ctx) => {
    const base = loadShortcuts(options, ctx);
    try {
      const entries = await host(
        ctx,
        base.items.map((item) => ({ ...item })),
      );
      if (!Array.isArray(entries)) return base;
      const seen = new Set<string>();
      const items: ShortcutsWidgetData['items'] = [];
      for (const entry of entries as (ShortcutEntry & { id?: unknown })[]) {
        if (!entry || typeof entry.href !== 'string') continue;
        let id =
          typeof entry.id === 'string' && entry.id ? entry.id : entry.href;
        if (seen.has(id)) id = `${id}#${items.length}`;
        seen.add(id);
        items.push({ ...entry, id });
      }
      return { items };
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return base;
    }
  };
}

export interface CookbookRegistryOptions {
  /**
   * Data loaders for `metric`, `records` and `chart` (omitted ones are not
   * registered), and an optional `shortcuts` loader that receives the
   * registry's default entries.
   */
  loaders?: CookbookLoaders;
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
    shortcuts: composeShortcutsLoader(options.loaders?.shortcuts),
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
