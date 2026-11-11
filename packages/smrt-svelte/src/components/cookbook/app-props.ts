/** Shell-dependent props, kept outside the plain cookbook data contract. */
import type { Cookbook } from '@happyvertical/smrt-types';
import type { ComponentProps } from 'svelte';
import type AppShell from '../app/AppShell.svelte';
import type { RecipeExportResolver } from '../overview/recipe-widgets.js';
import type { ScreenPolicy } from '../screens/types.js';
import type {
  BuildCookbookShellOptions,
  CookbookCatalog,
  CookbookLoaders,
  CookbookShortcutsLoader,
} from './types.js';

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
      | 'borderRadius'
      | 'density'
      | 'contrast'
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
  /** Resolved once by the owning policy engine at the server boundary. */
  fieldPolicies?: Readonly<Record<string, ScreenPolicy>>;
  /** Expanded section entries are the default; use `sections` for headings only. */
  navMode?: 'sections' | 'sections-with-items';
  /**
   * Data loaders for the `metric`, `records` and `chart` widgets. With
   * `metric` and `records`, section pages also show a record count and the
   * latest records of the section's lead model. `shortcuts` composes with the
   * registry's own entries (see {@link CookbookShortcutsLoader}).
   */
  loaders?: CookbookLoaders;
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
