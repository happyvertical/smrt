import type { PaletteProvider } from '@happyvertical/smrt-svelte/command-palette';
import type { Recipe } from '../recipes/types.ts';
import { demoBadge, effectiveDemo } from './demo.ts';

/** The Planner page's tabs, as the palette offers them. */
export const PLANNER_TAB_COMMANDS = [
  { id: 'cookbooks', title: 'Open Cookbooks' },
  { id: 'recipes', title: 'Open Recipes' },
  { id: 'features', title: 'Browse features' },
  { id: 'layout', title: 'Open Layout' },
  { id: 'settings', title: 'Open Settings' },
  { id: 'export', title: 'Open Export' },
] as const;

export interface PlannerPaletteOptions {
  recipes: readonly Recipe[];
  /** Whether the recipe is already in the cookbook. */
  isOn: (id: string) => boolean;
  /** Add the recipe, with what it requires. */
  add: (id: string) => void;
  /** In-app path of a Planner tab, with the app query. */
  href: (tab: string) => string;
}

/**
 * The planner's own providers: its tabs, and "Add <feature>" for every recipe
 * not yet on (the palette's items are re-read each time it opens, so a recipe
 * added elsewhere drops out). Choosing one adds it and lands on the Features
 * tab, where the card shows it on. The subtitle carries the same demo label
 * the card does, so a server-only feature is not offered as if it were live.
 */
export function plannerProviders(
  options: PlannerPaletteOptions,
): PaletteProvider[] {
  return [
    {
      id: 'planner-tabs',
      label: 'Planner',
      order: 20,
      items: () =>
        PLANNER_TAB_COMMANDS.map((tab) => ({
          id: tab.id,
          title: tab.title,
          kind: 'navigation',
          href: options.href(tab.id),
        })),
    },
    {
      id: 'planner-features',
      label: 'Add a feature',
      order: 30,
      items: () =>
        options.recipes
          .filter((recipe) => !options.isOn(recipe.id))
          .map((recipe) => {
            const label = demoBadge(effectiveDemo(recipe))?.label;
            return {
              id: recipe.id,
              title: `Add ${recipe.label}`,
              subtitle: label ? `${label}: ${recipe.summary}` : recipe.summary,
              keywords: recipe.synonyms,
              kind: 'command',
              run: ({ navigate }) => {
                options.add(recipe.id);
                return navigate(options.href('features'));
              },
            };
          }),
    },
  ];
}
