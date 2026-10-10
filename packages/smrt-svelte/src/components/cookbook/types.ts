/**
 * Inputs and outputs of the cookbook app shell (#3749).
 *
 * Everything here is plain data: the builder takes a cookbook plus a recipe
 * catalog and returns shell configuration; nothing imports Svelte or the DOM.
 */
import type {
  Cookbook,
  CookbookPolicyRow,
  RecipeDefinition,
  RecipeShellSlot,
  RecipeWidgetSurface,
} from '@happyvertical/smrt-types';
import type { ComponentProps } from 'svelte';
import type AppShell from '../app/AppShell.svelte';
import type { RecipeExportResolver } from '../overview/recipe-widgets.js';
import type { OverviewDefinition } from '../overview/types.js';
import type { CoreWidgetLoaders } from '../overview/widgets/core.js';
import type { ShellLayout } from '../workspace/admin-shell/layout.js';
import type { ShellNavGroup } from '../workspace/admin-shell/types.js';

/**
 * The part of a recipe the shell reads. A manifest `RecipeDefinition` fits;
 * hosts may drop `help`, `synonyms` and other bulk before serializing.
 */
export type CookbookRecipe = Pick<
  RecipeDefinition,
  'id' | 'label' | 'nav' | 'models'
> &
  Partial<
    Pick<
      RecipeDefinition,
      'group' | 'section' | 'surfaces' | 'requires' | 'requiresAny'
    >
  >;

/** What the shell needs to know about one model. */
export interface CookbookModelInfo {
  /** Qualified name, `@scope/pkg:Class`. */
  id: string;
  /** Class name, e.g. `Order`. */
  name: string;
  /** Package id used in item ids and routes: `commerce` for `@happyvertical/smrt-commerce`. */
  packageId: string;
  /** The model's own description, for an entry with no description of its own. */
  description?: string;
  /** Has an API, MCP or CLI surface; only exposed models get a feature entry. */
  exposed?: boolean;
}

/** Recipes plus the models they point at: the catalog a cookbook resolves against. */
export interface CookbookCatalog {
  recipes: readonly CookbookRecipe[];
  models: readonly CookbookModelInfo[];
}

/** One navigation entry: a layout item id and the model page it opens. */
export interface CookbookEntry {
  /** Layout item id: `item:<package>:<Model>` or `item:<package>:<Model>:<key>`. */
  id: string;
  label: string;
  icon: string;
  description: string;
  model: CookbookModelInfo;
  /** In-app path of the entry's page, without any host base. */
  path: string;
  /** Link the nav uses (`path` through `entryHref`). */
  href: string;
  /** Explicit noun for the New button. */
  noun?: string;
  /** Row filter of a keyed entry. */
  filter?: { field: string; value: string };
  /** Recipe that contributed the entry; `null` for a feature model. */
  recipeId: string | null;
}

/** A suggested navigation section and what it holds. */
export interface CookbookSection {
  /** Layout id: `section:<id>`. */
  id: string;
  label: string;
  icon?: string;
  description?: string;
  /** Entry ids, in recipe order. */
  entryIds: string[];
  /** Ids of the recipes that suggest the section. */
  recipeIds: string[];
  /** In-app path of the section page. */
  path: string;
}

/** A recipe surface placed into a shell slot. */
export interface CookbookShellWidget {
  recipeId: string;
  slot: RecipeShellSlot;
  /** `'<module specifier>#<ExportName>'`; the host resolves it. */
  export: `${string}#${string}`;
  label: string;
  icon?: string;
}

export interface CookbookRouteSurface {
  recipeId: string;
  path: string;
  export: `${string}#${string}`;
  label: string;
}

export interface CookbookSettingsPanel {
  recipeId: string;
  export: `${string}#${string}`;
  label: string;
}

/** The theme as the shell applies it; a brand colour is registered by the component. */
export interface ResolvedCookbookTheme {
  /** Preset id: a built-in smrt-ui preset, or the brand theme's id. */
  preset: string;
  colorScheme: 'light' | 'dark' | 'system';
  /** Present when the cookbook names a brand colour (it wins over `preset`). */
  brand?: { primary: string; fontFamily?: string };
}

/** One section page: its overview definition and the cookbook's saved override. */
export interface CookbookOverviewPage {
  definition: OverviewDefinition;
  /** The cookbook's stored override for this page, if any (untrusted JSON). */
  override: unknown;
}

export interface BuildCookbookShellOptions {
  cookbook: Cookbook;
  /** Recipes and models, usually from {@link catalogFromManifests}. */
  catalog: CookbookCatalog;
  /** The app name shown in the shell brand. */
  title?: string;
  /**
   * Recipe order, when it differs from the cookbook's (the cookbook lists ids
   * sorted). Recipes it does not list follow in cookbook order. Section order
   * follows the first recipe of each section, then the cookbook layout.
   */
  recipeOrder?: readonly string[];
  /** In-app path of a model entry; default `/m/<package>/<Model>/[key/]`. */
  entryPath?: (entry: {
    packageId: string;
    modelName: string;
    key?: string;
  }) => string;
  /** In-app path of a section page; default `/s/<slug>/`. */
  sectionPath?: (sectionId: string) => string;
  /** Prefix for every generated href (`/app` or an app query helper). */
  href?: (path: string) => string;
  /**
   * Put a record count and the latest records on every section page. They need
   * `metric` and `records` loaders on the host; without them leave this off
   * and the page shows the entries as shortcut cards only.
   */
  dataWidgets?: boolean;
  /** Where the app's settings page lives; passed through to the shell. */
  settingsHref?: string;
}

/** Everything `AppShell` and the section pages need, derived from a cookbook. */
export interface CookbookShell {
  title: string;
  navMode: 'sections';
  /** Sections as the shell takes them (layout is applied by the shell). */
  navGroups: ShellNavGroup[];
  /** The cookbook's layout, or `null` when it has none. */
  layout: ShellLayout | null;
  /** Suggested sections in order, whether or not the layout hides them. */
  sections: CookbookSection[];
  /** Every entry by layout item id. */
  entries: ReadonlyMap<string, CookbookEntry>;
  theme: ResolvedCookbookTheme;
  /** Section page overviews by section id (`section:sales`, `custom:shop`). */
  overviews: Record<string, CookbookOverviewPage>;
  /** Recipe `shell-widget` surfaces, for the host to resolve into `slotItems`. */
  shellWidgets: CookbookShellWidget[];
  routes: CookbookRouteSurface[];
  settingsPanels: CookbookSettingsPanel[];
  /** Recipe `widget` surfaces, for `registerRecipeWidgets`. */
  widgets: Array<
    Pick<RecipeDefinition, 'id'> & { surfaces: RecipeWidgetSurface[] }
  >;
  /** The cookbook's app-scope field policy rows, applied by the runtime. */
  policies: CookbookPolicyRow[];
  settingsHref?: string;
  /** Layout id to section page path (the shell's `sectionHref`). */
  sectionPath: (sectionId: string) => string;
  /** Problems that did not stop the build (unknown recipes, models, ...). */
  issues: string[];
}

/** Props of `CookbookSectionPage`. */
export interface CookbookSectionPageProps {
  /** The layout id (`section:sales`, `custom:shop`). */
  sectionId?: string;
  /** The route slug (`section-sales`); used when `sectionId` is absent. */
  slug?: string;
  /** Extra content under the overview. */
  children?: import('svelte').Snippet;
}

/** Props of `CookbookApp`; anything else is passed to `AppShell` unchanged. */
export interface CookbookAppProps
  extends Omit<
      ComponentProps<typeof AppShell>,
      | 'navGroups'
      | 'nav'
      | 'navMode'
      | 'layout'
      | 'onlayoutchange'
      | 'preset'
      | 'colorScheme'
      | 'sectionHref'
      | 'title'
      | 'children'
    >,
    Pick<
      BuildCookbookShellOptions,
      'recipeOrder' | 'entryPath' | 'sectionPath' | 'href' | 'title'
    > {
  cookbook: Cookbook;
  catalog: CookbookCatalog;
  /**
   * Data loaders for the `metric`, `records` and `chart` widgets. With
   * `metric` and `records`, section pages also show a record count and the
   * latest records of the section's lead model.
   */
  loaders?: Omit<CoreWidgetLoaders, 'shortcuts'>;
  /** Host capabilities handed to widget loaders that run in the browser. */
  widgetContext?: () => Record<string, unknown>;
  /**
   * Turns a recipe export reference (`'@acme/shop/svelte#SalesTotal'`) into
   * the export: a static map of dynamic imports in a bundled app. Without it,
   * recipe `widget` and `shell-widget` surfaces are ignored.
   */
  resolveExport?: RecipeExportResolver;
  /** Called with the cookbook after a layout or overview edit. */
  oncookbookchange?: (cookbook: Cookbook) => void;
  children: import('svelte').Snippet;
}
