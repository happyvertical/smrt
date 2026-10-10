import { getContext, setContext } from 'svelte';
import type { OverviewModelChoice } from '../overview/grid-types.js';
import type { WidgetComponents, WidgetRegistry } from '../overview/registry.js';
import type { OverviewOverride } from '../overview/types.js';
import type { CookbookShell } from './types.js';

/** What `CookbookApp` shares with `CookbookSectionPage` below it. */
export interface CookbookContext {
  readonly shell: CookbookShell;
  /** `null` until the recipe widgets are registered. */
  readonly registry: WidgetRegistry | null;
  readonly components: WidgetComponents;
  /** Models the overview option editor offers. */
  readonly models: readonly OverviewModelChoice[];
  /** The page's stored override (untrusted JSON), reactive. */
  overrideFor(sectionId: string): unknown;
  /** Store an edit; `null` resets the page to its defaults. */
  setOverride(sectionId: string, override: OverviewOverride | null): void;
  /** Host capabilities passed to widget loaders (a data source, ...). */
  widgetContext(): Record<string, unknown>;
}

const KEY = Symbol('smrt-cookbook');

export function setCookbookContext(context: CookbookContext): void {
  setContext(KEY, context);
}

export function tryGetCookbookContext(): CookbookContext | undefined {
  return getContext<CookbookContext | undefined>(KEY);
}

export function getCookbookContext(): CookbookContext {
  const context = tryGetCookbookContext();
  if (!context) {
    throw new Error(
      'CookbookSectionPage must be rendered inside <CookbookApp>.',
    );
  }
  return context;
}
