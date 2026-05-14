/**
 * Pure helpers for nav state derivation.
 *
 * Extracted so the recursive active/expanded logic can be unit-tested
 * without needing to mount Svelte components.
 *
 * No DOM, no Svelte runes, no SvelteKit imports — these are SSR-safe and
 * deterministic given their inputs.
 */

import type { NavItem } from './types.js';

/**
 * Default activeness check for a nav item against a current path.
 *
 * - Exact match → active
 * - `item.exact === true` → only exact match counts
 * - `item.href === '/'` → only matches `currentPath === '/'`; otherwise
 *   the descendant-path fallback would degrade to `startsWith('//')`
 *   and never fire (and we don't want every path counting the root as
 *   active by ancestry).
 * - Otherwise, active when `currentPath` starts with `item.href + '/'`
 *   (the trailing slash avoids `/foo` matching `/foobar`).
 */
export function defaultIsActive(item: NavItem, currentPath: string): boolean {
  if (item.href === currentPath) return true;
  if (item.exact) return false;
  // The root href would produce `startsWith('//')`, which never matches a
  // real path. Treat root as exact-only when not flagged with `exact`.
  if (item.href === '/') return false;
  return currentPath.startsWith(`${item.href}/`);
}

/**
 * True if the item or any descendant is active under `isActive`.
 */
export function isItemOrChildActive(
  item: NavItem,
  currentPath: string,
  isActive: (item: NavItem, currentPath: string) => boolean = defaultIsActive,
): boolean {
  if (isActive(item, currentPath)) return true;
  if (item.children) {
    for (const child of item.children) {
      if (isItemOrChildActive(child, currentPath, isActive)) return true;
    }
  }
  return false;
}

/**
 * True when an item's children container should render as expanded.
 *
 * Children are expanded when:
 *  - the item has children, AND
 *  - one of its descendants is active, OR `item.defaultExpanded` is set.
 */
export function isExpanded(
  item: NavItem,
  currentPath: string,
  isActive: (item: NavItem, currentPath: string) => boolean = defaultIsActive,
): boolean {
  if (!item.children?.length) return false;
  if (item.defaultExpanded) return true;
  return isItemOrChildActive(item, currentPath, isActive);
}
