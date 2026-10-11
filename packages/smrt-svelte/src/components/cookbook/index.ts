/**
 * @happyvertical/smrt-svelte/cookbook
 *
 * A cookbook-driven app shell (#3749): `buildCookbookShell` turns a cookbook
 * plus a recipe catalog into `AppShell` configuration (sections, entries,
 * layout, theme, section overviews, recipe surfaces); `CookbookApp` renders it
 * and `CookbookSectionPage` is a section's own page. Browser-safe: use
 * `@happyvertical/smrt-svelte/cookbook/server` to load the cookbook and the
 * installed packages' manifests in a `+layout.server.ts`.
 */
export { applyCookbookTheme } from './brand-theme.js';
export { buildCookbookShell, humanize, pluralize } from './build.js';
export { default as CookbookApp } from './CookbookApp.svelte';
export { default as CookbookSectionPage } from './CookbookSectionPage.svelte';
export {
  type CookbookManifest,
  catalogFromManifests,
  narrowCatalog,
  packageIdOf,
} from './catalog.js';
export {
  type CookbookContext,
  getCookbookContext,
  tryGetCookbookContext,
} from './context.js';
export {
  type CookbookOverviewStore,
  createSectionOverview,
  loadSectionWidget,
} from './page.js';
export {
  type CookbookRegistry,
  type CookbookRegistryOptions,
  type CookbookWidgetContext,
  createCookbookRegistry,
  loadShortcuts,
} from './registry.js';
export {
  buildNavSections,
  DEFAULT_ENTRY_ICON,
  DEFAULT_SECTION_ICON,
  defaultEntryPath,
  defaultSectionPath,
  FEATURE_SECTION,
  navItemId,
  navSectionOf,
  sectionIdFromSlug,
  sectionLayoutId,
  sectionSlug,
} from './sections.js';
export {
  brandThemeId,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_THEME_PRESET,
  normalizeHex,
  resolveCookbookTheme,
  THEME_FONTS,
} from './theme.js';
export type * from './types.js';
