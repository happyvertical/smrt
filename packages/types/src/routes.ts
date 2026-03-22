/**
 * Shared route contract types for SMRT packages.
 *
 * Packages can export route modules that describe their page surfaces without
 * owning the consuming app's physical route tree. Apps stay responsible for
 * URL shape, auth, tenancy, and layout composition while reusing package-owned
 * page components and loader helpers.
 */

import type { ModuleComponentType } from './module.js';

/**
 * Route load function category.
 *
 * `page` maps naturally to SvelteKit's `+page.ts`, while `page-server` maps to
 * `+page.server.ts`.
 */
export type SmrtRouteLoadKind = 'page' | 'page-server';

/**
 * Navigation metadata for a package route.
 */
export interface SmrtRouteNavigationMeta {
  /** Label shown in app navigation. */
  label: string;
  /** Optional route description for menus or docs. */
  description?: string;
  /** Optional icon identifier. */
  icon?: string;
  /** Display order (lower first). */
  order?: number;
  /** Optional grouping key for larger menus. */
  group?: string;
}

/**
 * Resolved navigation entry for a mounted route.
 */
export interface SmrtRouteNavigationItem {
  /** Stable route identifier. */
  routeId: string;
  /** Link href as mounted by the consuming app. */
  href: string;
  /** Label shown in the app navigation. */
  label: string;
  /** Optional description for menu UI. */
  description?: string;
  /** Optional icon identifier. */
  icon?: string;
  /** Display order (lower first). */
  order?: number;
  /** Optional grouping key for larger menus. */
  group?: string;
}

/**
 * Package-owned route definition.
 *
 * @typeParam TData - Data shape the route component expects.
 * @typeParam TLoadInput - Input accepted by the optional `load` helper.
 * @typeParam TProps - Component props shape. Defaults to `{ data?: TData }`.
 */
export interface SmrtRouteDefinition<
  TData = unknown,
  TLoadInput = unknown,
  TProps = { data?: TData },
> {
  /** Stable route identifier, namespaced by package. */
  id: string;
  /** Human-readable page title. */
  title: string;
  /** Optional description for docs and tooling. */
  description?: string;
  /** Canonical path the package recommends by default. */
  defaultPath: string;
  /** Page component exported by the package. */
  component: ModuleComponentType<TProps>;
  /** Optional reusable load helper for app-owned route files. */
  load?: (input: TLoadInput) => Promise<TData> | TData;
  /** Which SvelteKit route file the `load` helper belongs in. */
  loadKind?: SmrtRouteLoadKind;
  /** Optional navigation metadata. */
  nav?: SmrtRouteNavigationMeta;
  /** Optional tags for docs, hosts, or filtering. */
  tags?: string[];
}

/**
 * Package-owned route module.
 *
 * Consumers import one of these from `@happyvertical/smrt-<pkg>/routes`, then
 * mount the exported components and loaders inside their own app route tree.
 *
 */
export interface SmrtRouteModule {
  /** Package name, usually `@happyvertical/smrt-<pkg>`. */
  packageName: string;
  /** Human-readable module name. */
  displayName: string;
  /** Optional module description. */
  description?: string;
  /** Route definitions keyed by package-local name. */
  routes: Record<string, SmrtRouteDefinition<any, any, any>>;
}
