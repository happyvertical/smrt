import type { ShellNavGroup } from '@happyvertical/smrt-svelte/workspace';
import { applyShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import type { Cookbook } from '../cookbook/types.ts';
import { FEATURE_SECTION, featureNavItems } from '../recipes/features.ts';
import { buildNavSections, recipeNav, recipesById } from '../recipes/index.ts';
import { navItemId } from '../recipes/sections.ts';
import type { CookbookLayout, MenuSection } from './types.ts';

/**
 * The navigation a cookbook produces before its layout: one group per nav
 * section, items in recipe order, with the same stable ids the app shell uses
 * (`navItemId`), so a layout's ids line up with what the app generates.
 */
export function cookbookNavGroups(
  cookbook: Pick<Cookbook, 'recipes' | 'features'>,
): ShellNavGroup[] {
  const added = cookbook.recipes.flatMap((id) => {
    const recipe = recipesById.get(id);
    return recipe ? [recipe] : [];
  });
  const groups: ShellNavGroup[] = buildNavSections(added).map((section) => {
    const seen = new Set<string>();
    const items: ShellNavGroup['items'] = [];
    for (const recipe of section.recipes) {
      for (const entry of recipeNav(recipe)) {
        const id = navItemId(entry.packageId, entry.model.name, entry.key);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({
          id,
          href: '#',
          label: entry.label,
          icon: entry.icon,
          description: entry.description,
        });
      }
    }
    return { id: `section:${section.id}`, heading: section.label, items };
  });
  const features = featureNavItems(cookbook.features).map((item) => ({
    id: item.id,
    href: '#',
    label: item.label,
    icon: item.icon,
    description: item.description,
  }));
  if (features.length) {
    groups.push({
      id: `section:${FEATURE_SECTION.id}`,
      heading: FEATURE_SECTION.label,
      items: features,
    });
  }
  return groups;
}

/**
 * The menu a cookbook gives its app, in the visitor's own words: sections and
 * entries after the layout is applied (moves, hides, renames), with each
 * entry's `layout.items` label. Pure, so the Cookbooks preview shows exactly
 * what applying the cookbook will build.
 */
export function previewMenu(
  cookbook: Pick<Cookbook, 'recipes' | 'features'> & {
    layout?: CookbookLayout;
  },
): MenuSection[] {
  const layout = cookbook.layout;
  const applied = applyShellLayout(
    [],
    cookbookNavGroups(cookbook),
    undefined,
    layout,
  );
  return applied.groups.map((group) => ({
    id: group.id ?? String(group.heading),
    label: group.heading ?? '',
    entries: group.items.map((item) => ({
      id: item.id ?? item.href,
      label: layout?.items?.[item.id ?? item.href]?.label?.trim() || item.label,
    })),
  }));
}
