/**
 * Pure helpers for breadcrumb derivation.
 *
 * Extracted so the path-walking logic can be unit-tested without rendering
 * a Svelte component.
 */

import type { BreadcrumbItem, NavItem } from './types.js';

/**
 * Walk a nav tree depth-first and return the label of the item whose
 * `href` matches exactly, or `null` if not found.
 */
export function findLabelInNav(items: NavItem[], href: string): string | null {
  for (const item of items) {
    if (item.href === href) return item.label;
    if (item.children?.length) {
      const label = findLabelInNav(item.children, href);
      if (label) return label;
    }
  }
  return null;
}

/**
 * Default label fallback for unknown segments: capitalize the first letter
 * and turn dashes/underscores into spaces.
 */
export function capitalizeSegment(segment: string): string {
  if (!segment) return segment;
  const cleaned = segment.replace(/[-_]/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export interface DeriveCrumbsOptions {
  /** Optional first crumb (e.g., site identity). */
  rootCrumb?: BreadcrumbItem;
  /**
   * Skip pathname segments until (and including) the given path is matched.
   * Example: `startAfter: 'sites/foo'` ignores everything up through
   * `/sites/foo` in the pathname.
   */
  startAfter?: string;
  /** Fall back to capitalized segments for unmatched paths (default: true). */
  capitalize?: boolean;
}

/**
 * Derive a breadcrumb trail from a pathname + nav tree.
 *
 * Strategy:
 *  1. Optionally prepend `rootCrumb`.
 *  2. Split the pathname into segments.
 *  3. If `startAfter` is set, locate its trailing segment in the
 *     pathname and skip everything before/including it. The
 *     `startAfter` value may include a leading slash or none and
 *     may be a multi-segment path (e.g. `sites/foo`).
 *  4. Walk the remaining segments, building cumulative paths; for
 *     each, try to find a matching nav label, otherwise capitalize.
 */
export function deriveCrumbsFromNav(
  pathname: string,
  nav: NavItem[],
  options: DeriveCrumbsOptions = {},
): BreadcrumbItem[] {
  const { rootCrumb, startAfter, capitalize = true } = options;
  const result: BreadcrumbItem[] = [];

  if (rootCrumb) {
    result.push(rootCrumb);
  }

  const segments = (pathname || '').split('/').filter(Boolean);

  // Resolve which segment index we start emitting crumbs after.
  let startIndex = 0;
  let basePath = '';
  if (startAfter) {
    const startSegments = startAfter.split('/').filter(Boolean);
    if (startSegments.length > 0) {
      // Match the full contiguous `startSegments` sequence in `segments`,
      // not just the last token — otherwise an ambiguous pathname like
      // `/sites/sites/content` with `startAfter: 'sites/sites'` would
      // anchor on the first `sites` and build the wrong base path.
      let matched = false;
      outer: for (let i = 0; i <= segments.length - startSegments.length; i++) {
        for (let j = 0; j < startSegments.length; j++) {
          if (segments[i + j] !== startSegments[j]) continue outer;
        }
        startIndex = i + startSegments.length;
        basePath = `/${segments.slice(0, startIndex).join('/')}`;
        matched = true;
        break;
      }
      if (!matched) {
        // startAfter not in path → nothing to walk.
        return result;
      }
    }
  }

  let currentPath = basePath;
  for (const segment of segments.slice(startIndex)) {
    currentPath += `/${segment}`;
    const label =
      findLabelInNav(nav, currentPath) ??
      (capitalize ? capitalizeSegment(segment) : segment);
    result.push({ label, href: currentPath });
  }

  return result;
}
