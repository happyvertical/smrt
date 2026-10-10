/**
 * `buildCookbookShell` (#3749): turn a cookbook plus a recipe catalog into the
 * configuration of `AppShell` and its section pages. Pure data in, plain data
 * out: no DOM, no Svelte, so a server load, a test and the browser all derive
 * the same navigation from the same cookbook.
 *
 * The logic is smrt-planner's (`+layout.svelte`, `recipes/*`, `sections/*`,
 * `overviews/*`) with the planner-only pieces left out: option and help pages,
 * the package browser and the sample data source.
 */
import type { Cookbook, RecipeWidgetSurface } from '@happyvertical/smrt-types';
import {
  defineOverview,
  isEmptyOverride,
  parseOverviewOverride,
} from '../overview/model.js';
import {
  OVERVIEW_PAGE_ID_PATTERN,
  type OverviewDefinition,
  type OverviewWidget,
} from '../overview/types.js';
import type { ShellLayout } from '../workspace/admin-shell/layout.js';
import type {
  ShellNavGroup,
  ShellNavItem,
} from '../workspace/admin-shell/types.js';
import {
  buildNavSections,
  DEFAULT_ENTRY_ICON,
  defaultEntryPath,
  defaultSectionPath,
  entryDescription,
  FEATURE_SECTION,
  navItemId,
  sectionLayoutId,
} from './sections.js';
import { resolveCookbookTheme } from './theme.js';
import type {
  BuildCookbookShellOptions,
  CookbookEntry,
  CookbookModelInfo,
  CookbookOverviewPage,
  CookbookRecipe,
  CookbookRouteSurface,
  CookbookSection,
  CookbookSettingsPanel,
  CookbookShell,
  CookbookShellWidget,
} from './types.js';

/** `PurchaseOrder` -> `Purchase Order`. */
export function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** `Customer` -> `Customers`, `Category` -> `Categories`. */
export function pluralize(noun: string): string {
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/** The recipes the cookbook selects, in catalog order; unknown ids are reported. */
function selectRecipes(
  options: BuildCookbookShellOptions,
  issues: string[],
): CookbookRecipe[] {
  const { cookbook, catalog, recipeOrder } = options;
  const byId = new Map(catalog.recipes.map((r) => [r.id, r]));
  const wanted = new Set(cookbook.recipes);
  const order = [...(recipeOrder ?? []), ...catalog.recipes.map((r) => r.id)];
  const picked: CookbookRecipe[] = [];
  const done = new Set<string>();
  for (const id of order) {
    const recipe = byId.get(id);
    if (!recipe || !wanted.has(id) || done.has(id)) continue;
    done.add(id);
    picked.push(recipe);
  }
  for (const id of cookbook.recipes) {
    if (!done.has(id)) issues.push(`Unknown recipe "${id}".`);
  }
  return picked;
}

/**
 * The section's lead model: the first nav entry of the first recipe that
 * suggests the section. Its count and records go on the section page.
 */
function leadModel(
  recipes: readonly CookbookRecipe[],
  models: ReadonlyMap<string, CookbookModelInfo>,
): CookbookModelInfo | undefined {
  for (const recipe of recipes) {
    for (const entry of recipe.nav) {
      const model = models.get(entry.model);
      if (model) return model;
    }
  }
  return undefined;
}

function overviewDefaults(
  lead: CookbookModelInfo | undefined,
  dataWidgets: boolean,
): OverviewWidget[] {
  const widgets: OverviewWidget[] = [
    { id: 'shortcuts', type: 'shortcuts', span: 4, options: {} },
  ];
  if (dataWidgets && lead) {
    const name = humanize(lead.name);
    widgets.push(
      {
        id: 'count',
        type: 'metric',
        span: 1,
        options: { title: pluralize(name), model: lead.id, measure: 'count' },
      },
      {
        id: 'latest',
        type: 'records',
        span: 3,
        options: { title: `${name} records`, model: lead.id, limit: 5 },
      },
    );
  }
  return widgets;
}

/** The cookbook layout as the shell takes it: `null` when it has none. */
function layoutOf(cookbook: Cookbook): ShellLayout | null {
  return cookbook.layout ? (cookbook.layout as ShellLayout) : null;
}

/** Derive the shell configuration from a cookbook (see {@link CookbookShell}). */
export function buildCookbookShell(
  options: BuildCookbookShellOptions,
): CookbookShell {
  const { cookbook, catalog } = options;
  const issues: string[] = [];
  const href = options.href ?? ((path: string) => path);
  const entryPath = options.entryPath ?? defaultEntryPath;
  const sectionPath = options.sectionPath ?? defaultSectionPath;
  const models = new Map(catalog.models.map((m) => [m.id, m]));
  const recipes = selectRecipes(options, issues);

  const entries = new Map<string, CookbookEntry>();
  const sections: CookbookSection[] = [];
  const navGroups: ShellNavGroup[] = [];

  const addEntry = (
    recipe: CookbookRecipe | null,
    spec: {
      model: CookbookModelInfo;
      label: string;
      icon?: string;
      description?: string;
      key?: string;
      noun?: string;
      filter?: { field: string; value: string };
    },
  ): CookbookEntry | undefined => {
    const id = navItemId(spec.model.packageId, spec.model.name, spec.key);
    if (entries.has(id)) return undefined;
    const path = entryPath({
      packageId: spec.model.packageId,
      modelName: spec.model.name,
      ...(spec.key ? { key: spec.key } : {}),
    });
    const entry: CookbookEntry = {
      id,
      label: spec.label,
      icon: spec.icon ?? DEFAULT_ENTRY_ICON,
      description: entryDescription(spec.description, spec.model),
      model: spec.model,
      path,
      href: href(path),
      recipeId: recipe?.id ?? null,
      ...(spec.noun ? { noun: spec.noun } : {}),
      ...(spec.filter ? { filter: spec.filter } : {}),
    };
    entries.set(id, entry);
    return entry;
  };

  const toItem = (entry: CookbookEntry): ShellNavItem => ({
    id: entry.id,
    href: entry.href,
    label: entry.label,
    icon: entry.icon,
    description: entry.description,
  });

  const pushSection = (
    id: string,
    label: string,
    icon: string | undefined,
    description: string | undefined,
    recipeIds: string[],
    items: CookbookEntry[],
  ) => {
    const layoutId = sectionLayoutId(id);
    const path = sectionPath(layoutId);
    sections.push({
      id: layoutId,
      label,
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
      entryIds: items.map((e) => e.id),
      recipeIds,
      path,
    });
    navGroups.push({
      id: layoutId,
      heading: label,
      ...(icon ? { icon } : {}),
      href: href(path),
      items: items.map(toItem),
    });
  };

  // Recipe sections: a section none of whose recipes has a menu entry (an
  // assistant, a settings panel) is left out rather than shown empty.
  const leads = new Map<string, CookbookModelInfo | undefined>();
  for (const section of buildNavSections(recipes)) {
    const items: CookbookEntry[] = [];
    for (const recipe of section.recipes) {
      for (const nav of recipe.nav) {
        const model = models.get(nav.model);
        if (!model) {
          issues.push(`Recipe ${recipe.id} lists unknown model ${nav.model}.`);
          continue;
        }
        const entry = addEntry(recipe, {
          model,
          label: nav.label,
          icon: nav.icon,
          description: nav.description,
          key: nav.key,
          noun: nav.noun,
          filter: nav.filter,
        });
        if (entry) items.push(entry);
      }
    }
    if (items.length === 0) continue;
    leads.set(sectionLayoutId(section.id), leadModel(section.recipes, models));
    pushSection(
      section.id,
      section.label,
      section.icon,
      section.description ??
        section.recipes.find((r) => r.group?.summary)?.group?.summary,
      section.recipes.map((r) => r.id),
      items,
    );
  }

  // Features: exposed models no recipe covers, in one section after the recipes'.
  const featureItems: CookbookEntry[] = [];
  for (const id of cookbook.features ?? []) {
    const model = models.get(id);
    if (!model?.exposed) {
      issues.push(`Feature ${id} is not an exposed model.`);
      continue;
    }
    const entry = addEntry(null, { model, label: humanize(model.name) });
    if (entry) featureItems.push(entry);
  }
  if (featureItems.length > 0) {
    leads.set(sectionLayoutId(FEATURE_SECTION.id), featureItems[0]?.model);
    pushSection(
      FEATURE_SECTION.id,
      FEATURE_SECTION.label,
      FEATURE_SECTION.icon,
      FEATURE_SECTION.description,
      [],
      featureItems,
    );
  }

  // Section page overviews: one per suggested section and per custom section
  // of the layout, so a cookbook's `overviews` key names the page it
  // customises and stays valid when the section is renamed.
  const layout = layoutOf(cookbook);
  const modelIds = catalog.models.map((m) => m.id);
  const overviews: Record<string, CookbookOverviewPage> = {};
  const overviewIds = [
    ...sections.map((s) => s.id),
    ...(layout?.customSections ?? []).map((s) => s.id),
  ];
  for (const id of new Set(overviewIds)) {
    // A hand-edited custom id outside the pattern has no overview: its page
    // shows the menu.
    if (!OVERVIEW_PAGE_ID_PATTERN.test(id)) continue;
    const definition: OverviewDefinition = defineOverview({
      id,
      ...(modelIds.length > 0 ? { models: modelIds } : {}),
      defaults: overviewDefaults(leads.get(id), options.dataWidgets === true),
    });
    const stored = cookbook.overviews?.[id];
    const parsed = parseOverviewOverride(stored);
    for (const issue of parsed.issues) {
      issues.push(`Overview ${id}: ${issue.message}`);
    }
    overviews[id] = {
      definition,
      override: isEmptyOverride(parsed.override) ? null : stored,
    };
  }
  for (const id of Object.keys(cookbook.overviews ?? {})) {
    if (!overviews[id]) {
      issues.push(
        `Overview "${id}" names no section; its override is ignored.`,
      );
    }
  }

  // Recipe surfaces placed into shell slots and routes.
  const shellWidgets: CookbookShellWidget[] = [];
  const routes: CookbookRouteSurface[] = [];
  const settingsPanels: CookbookSettingsPanel[] = [];
  const widgets: CookbookShell['widgets'] = [];
  for (const recipe of recipes) {
    const found: RecipeWidgetSurface[] = [];
    for (const surface of recipe.surfaces ?? []) {
      if (surface.kind === 'shell-widget') {
        shellWidgets.push({
          recipeId: recipe.id,
          slot: surface.slot,
          export: surface.export,
          label: surface.label,
          ...(surface.icon ? { icon: surface.icon } : {}),
        });
      } else if (surface.kind === 'route') {
        routes.push({
          recipeId: recipe.id,
          path: surface.path,
          export: surface.export,
          label: surface.label,
        });
      } else if (surface.kind === 'settings-panel') {
        settingsPanels.push({
          recipeId: recipe.id,
          export: surface.export,
          label: surface.label,
        });
      } else if (surface.kind === 'widget') found.push(surface);
    }
    if (found.length > 0) widgets.push({ id: recipe.id, surfaces: found });
  }

  return {
    title: options.title ?? cookbook.name ?? 'SMRT',
    navMode: 'sections',
    navGroups,
    layout,
    sections,
    entries,
    theme: resolveCookbookTheme(cookbook.theme),
    overviews,
    shellWidgets,
    routes,
    settingsPanels,
    widgets,
    policies: cookbook.policies ?? [],
    ...(options.settingsHref ? { settingsHref: options.settingsHref } : {}),
    sectionPath: (id) => href(sectionPath(id)),
    issues,
  };
}
