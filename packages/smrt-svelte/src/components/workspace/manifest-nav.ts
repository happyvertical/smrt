/**
 * Pure helper that turns a SMRT manifest into the `NavItem[]` shape the
 * existing `NavTree` / `RoleShell` primitives expect.
 *
 * This is the "manifest → admin UI" adapter called out as a friction gap in
 * happyvertical/smrt#1235 / #1226 / #1248: every consumer hand-writes its nav
 * config today, with dozens of `@smrt()` classes that boilerplate drifts.
 * Opt in here to manifest-driven nav while keeping the primitives themselves
 * SmrtObject-agnostic.
 *
 * Design constraints (see #1248 for the full brief):
 *  - Pure function. No SvelteKit imports, no SSR coupling, no module side
 *    effects. Data in → data out.
 *  - Cross-industry-safe. Never assumes apparel / furniture / automotive
 *    vocabulary; consumers supply their own `sectionHints`.
 *  - Deterministic output. Sections and items both sort alphabetically by
 *    title so manifest-order churn doesn't shuffle the rendered nav.
 *  - Decoupled from any concrete role/permission package. `permittedResources`
 *    is just a plain string array of qualified class names.
 *
 * The structural `SmrtManifestLike` / `SmrtManifestEntryLike` shapes here
 * intentionally subset the real `SmartObjectManifest` from `@happyvertical/smrt-core`.
 * Adding a peer dependency on core would create a circular reference (core
 * pulls in svelte primitives downstream), so the helper accepts anything
 * that matches the documented shape. Pass a `SmartObjectManifest` directly
 * and TypeScript is happy.
 */

// ────────────────────────────────────────────────────────────────────────
// Structural manifest types (subset of @happyvertical/smrt-core's
// `SmartObjectManifest`). Kept private to avoid leaking duplicate names
// into the workspace barrel.
// ────────────────────────────────────────────────────────────────────────

/**
 * Visibility flavours emitted by `@smrt({ visibility })`. Mirrors
 * `SmrtVisibility` in `@happyvertical/smrt-core` without importing it
 * (see the file-top note on why we avoid a core peer dep).
 */
type ManifestVisibility = 'public' | 'internal' | 'test';

/** Subset of `SmartObjectDefinition` the nav helper reads from. */
export interface SmrtManifestEntryLike {
  /** Qualified name in `@package/name:ClassName` form. Primary key. */
  qualifiedName?: string;
  /** Simple class name (PascalCase). */
  className: string;
  /** Package name where the class is defined. */
  packageName?: string;
  /** Pluralized resource name (used by the REST generator for the URL path). */
  collection?: string;
  /** Base class name as written in source. */
  extends?: string;
  /**
   * Top-level visibility flag — `SmartObjectDefinition` hoists this out of
   * `decoratorConfig` so it can be read without parsing the raw config. The
   * helper reads here first, then falls back to `decoratorConfig.visibility`
   * for older / hand-built manifests.
   */
  visibility?: ManifestVisibility;
  /**
   * The `@smrt({...})` config object captured by the AST scanner. Fields
   * are optional in the structural type so partial manifests still satisfy
   * it. The helper specifically looks at `ui?: { icon?, label? }`.
   */
  decoratorConfig?: {
    ui?: {
      icon?: string;
      label?: string;
    };
    /**
     * Subset of the `@smrt({ api })` shape we care about for nav filtering —
     * entries with `api: false` (or an `include` that drops `list` / an
     * `exclude` that drops `list`) don't get a REST list route and so
     * can't anchor a nav link.
     */
    api?:
      | boolean
      | { include?: string[]; exclude?: string[]; [key: string]: unknown };
    /**
     * Raw visibility flag as written in source. Read as a fallback when
     * the top-level `visibility` field is absent.
     */
    visibility?: ManifestVisibility;
    [key: string]: unknown;
  };
}

/** Subset of `SmartObjectManifest`. */
export interface SmrtManifestLike {
  objects: Record<string, SmrtManifestEntryLike>;
}

// ────────────────────────────────────────────────────────────────────────
// Public NavSection / NavSectionItem aliases.
//
// The existing `NavTree` primitive renders `NavItem[]`; a "section" is just
// a top-level `NavItem` whose `children` are the items in that section.
// We alias rather than re-shape so consumers can plug the result straight
// into `<NavTree items={...}>` or a `RoleConfig.sections`.
// ────────────────────────────────────────────────────────────────────────

import type { NavItem } from './types.js';

/**
 * A nav section emitted by `navTreeFromManifest`. Structurally identical to
 * `NavItem` — a top-level entry whose `children` are the resources grouped
 * under it. Aliased for documentation clarity.
 */
export type NavSection = NavItem;

/** Options consumed by {@link navTreeFromManifest}. */
export interface NavTreeFromManifestOptions {
  /**
   * Qualified class names a role is allowed to see (e.g.
   * `'@happyvertical/smrt-content:Article'`). Entries outside this list are
   * dropped. Omit to include every visible resource.
   *
   * Plain string array on purpose — this helper must not depend on
   * `smrt-users` or any concrete role / permission package. Wire your
   * resolver (`PermissionResolver` from smrt-users etc.) at the
   * `+layout.server.ts` level and pass the resulting allow-list in.
   */
  permittedResources?: string[];
  /**
   * Map of qualifier substring → section title. A class's qualified name
   * is checked against each key with `String.includes()`; the first match
   * wins. When no hint matches, the section title defaults to the package
   * suffix after the last `/` and before the `:` —
   * `@happyvertical/smrt-content:Article` → "smrt-content".
   *
   * @example
   * ```ts
   * sectionHints: {
   *   '@happyvertical/smrt-content': 'Content',
   *   '@happyvertical/smrt-commerce': 'Commerce',
   *   '@acme/apparel': 'Catalog',
   * }
   * ```
   */
  sectionHints?: Record<string, string>;
  /**
   * Base path for generated hrefs. Defaults to `/api/v1` so the emitted
   * URLs match SMRT's REST generator (`/api/v1/{collection}`). Pass an
   * empty string to emit unprefixed paths like `/articles`.
   */
  basePath?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Pluralization
//
// The brief explicitly says "use a tiny pluralization helper, don't pull
// in pluralize". This covers the common English suffix rules and is
// deterministic. Consumers who need exotic plurals override via
// `decoratorConfig.ui.label`.
// ────────────────────────────────────────────────────────────────────────

/**
 * Minimal English pluralizer. Handles the common suffix rules sufficient
 * for class-name → label conversion (Article → Articles, Category →
 * Categories, Box → Boxes, etc.). For irregulars or exotic plurals,
 * override with `@smrt({ ui: { label: 'Foo bars' } })`.
 *
 * Exported only for tests / advanced callers; most code should let
 * `navTreeFromManifest` apply it.
 */
export function pluralizeClassName(name: string): string {
  if (!name) return name;
  // Already plural-ish (very rough — "Categories" passes through).
  if (/(?:[^aeiouy]|qu)ies$/i.test(name)) return name;
  if (/s$/i.test(name) && !/(?:ss|us|is)$/i.test(name)) return name;

  // Words ending in consonant + 'y' → 'ies' (Category → Categories).
  if (/[^aeiouy]y$/i.test(name)) {
    return `${name.slice(0, -1)}ies`;
  }
  // Words ending in s, x, z, ch, sh → 'es' (Box → Boxes, Dish → Dishes).
  if (/(?:s|x|z|ch|sh)$/i.test(name)) {
    return `${name}es`;
  }
  return `${name}s`;
}

/** Convert a PascalCase class name to a kebab-case URL slug. */
function classNameToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// ────────────────────────────────────────────────────────────────────────
// Filtering — drop collection classes, internal/test visibility, etc.
// ────────────────────────────────────────────────────────────────────────

/**
 * True when an entry represents a `SmrtCollection` subclass rather than a
 * `SmrtObject`. The manifest captures both — collections appear with
 * `extends: 'SmrtCollection'` (or any ancestor whose own `extends` chain
 * eventually hits one), but the nav helper only cares about the SmrtObject
 * side. Heuristic: `className` ending in `Collection`. This matches the
 * SMRT convention (`ProductCollection`, `CategoryCollection`) and avoids
 * needing the full inheritance walk.
 */
function looksLikeCollectionClass(entry: SmrtManifestEntryLike): boolean {
  if (entry.className.endsWith('Collection')) return true;
  if (entry.extends === 'SmrtCollection') return true;
  return false;
}

/**
 * Whether an entry is publicly visible in the manifest. Classes marked
 * `@smrt({ visibility: 'internal' })` are package-only and should never
 * surface in admin nav — they're typically join tables, sync helpers, or
 * cross-package plumbing. `'test'` fixtures should obviously never leak
 * either. Default (`undefined` / `'public'`) keeps the entry visible.
 *
 * Reads the top-level `visibility` field first (the shape published by
 * `SmartObjectDefinition`) and falls back to `decoratorConfig.visibility`
 * for older / hand-built manifests.
 */
function isPublicEntry(entry: SmrtManifestEntryLike): boolean {
  const visibility =
    entry.visibility ?? entry.decoratorConfig?.visibility ?? 'public';
  return visibility === 'public';
}

/**
 * True when an entry is an STI subtype whose REST route would be the
 * same as some ancestor's. The SMRT scanner copies the STI parent's
 * `collection` field onto every child entry — `Material`, `Style`,
 * `Cart`, `Order`, `ProductionOrder` etc. all carry the parent's
 * `collection` value (`products`, `contracts`). If we emitted a nav
 * item per entry, the user would see "Materials" and "Products" both
 * linking to `/api/v1/products`, with no way to tell which list they
 * landed on. Suppressing the child entries keeps the base class's
 * single nav link — the REST endpoint already exposes the full
 * polymorphic list, which is the conventional shape for STI tables.
 *
 * **Walks the ancestor chain.** A two-level hierarchy like
 * `Product → Material → FabricMaterial` may have its intermediate
 * `Material` entry stripped from a partial manifest while `Product`
 * remains. A one-level check would let `FabricMaterial` through
 * (parent absent → return false → keep) and duplicate the `Product`
 * link. Walking the chain handles this case: as long as any ancestor
 * with a matching `collection` is reachable through the chain, the
 * subtype is suppressed. Fully-orphaned entries (no resolvable
 * ancestor in the manifest) stay visible — better to show one link
 * than none.
 *
 * Detection: starting at `entry.extends`, look up that className in
 * the manifest. If found and `collection` matches, suppress this
 * entry. Otherwise recurse into THAT entry's `extends` and try again.
 * Stop at `SmrtObject`/`SmrtClass`, when no manifest entry resolves,
 * or when a cycle is detected.
 */
function looksLikeStiSubtypeOfParentRoute(
  entry: SmrtManifestEntryLike,
  manifest: SmrtManifestLike,
): boolean {
  const byClassName = entryIndexByClassName(manifest);
  const visited = new Set<string>();
  let cursor: string | undefined = entry.extends;
  while (cursor && cursor !== 'SmrtObject' && cursor !== 'SmrtClass') {
    if (visited.has(cursor)) return false; // pathological cycle
    visited.add(cursor);
    const ancestor = byClassName.get(cursor);
    if (!ancestor) return false; // chain broken, keep this entry visible
    if (ancestor.collection && ancestor.collection === entry.collection) {
      return true;
    }
    cursor = ancestor.extends;
  }
  return false;
}

/**
 * Build a className → entry lookup over the manifest. Memoised per
 * manifest via WeakMap so a typical `navTreeFromManifest` call only
 * walks `Object.values(manifest.objects)` once even when many entries
 * trigger `looksLikeStiSubtypeOfParentRoute`. When two entries share
 * a className (shouldn't happen in a well-formed manifest), the first
 * one wins — duplicates would still produce the same dedup answer
 * because both would carry the same parent chain.
 */
const manifestClassNameIndex = new WeakMap<
  SmrtManifestLike,
  Map<string, SmrtManifestEntryLike>
>();

function entryIndexByClassName(
  manifest: SmrtManifestLike,
): Map<string, SmrtManifestEntryLike> {
  const cached = manifestClassNameIndex.get(manifest);
  if (cached) return cached;
  const idx = new Map<string, SmrtManifestEntryLike>();
  for (const e of Object.values(manifest.objects)) {
    if (!idx.has(e.className)) idx.set(e.className, e);
  }
  manifestClassNameIndex.set(manifest, idx);
  return idx;
}

/**
 * Whether an entry exposes a `list` route through the REST generator.
 *
 * Join-table / link / asset models commonly declare `@smrt({ api: false })`
 * because they're plumbing, not catalog. Linking a nav item to them would
 * 404 — the route literally isn't generated. Conservatively skip those.
 *
 * Handles the three shapes `@smrt({ api })` can take:
 *
 *   - `undefined` / `true` → default routes (list included)
 *   - `false` → no routes
 *   - `{ include: [...] }` → only listed routes
 *   - `{ exclude: [...] }` → all except listed routes
 */
function hasListRoute(entry: SmrtManifestEntryLike): boolean {
  const api = entry.decoratorConfig?.api;
  if (api === undefined || api === true) return true;
  if (api === false) return false;
  if (typeof api !== 'object' || api === null) return true;
  const obj = api as { include?: unknown; exclude?: unknown };
  if (Array.isArray(obj.include)) {
    return obj.include.includes('list');
  }
  if (Array.isArray(obj.exclude)) {
    return !obj.exclude.includes('list');
  }
  return true;
}

/**
 * Derive a section title for an entry. Order of preference:
 *  1. First `sectionHints` key whose substring appears in the qualified name.
 *  2. The package suffix between the last `/` and the `:` of the qualified
 *     name (e.g. `@happyvertical/smrt-content:Article` → `smrt-content`).
 *  3. The `packageName` field as-is, or `'Resources'` as a final fallback.
 */
function deriveSectionTitle(
  entry: SmrtManifestEntryLike,
  qualifier: string,
  sectionHints?: Record<string, string>,
): string {
  if (sectionHints) {
    for (const [needle, title] of Object.entries(sectionHints)) {
      if (qualifier.includes(needle)) return title;
    }
  }
  // `@happyvertical/smrt-content:Article` → after last `/`, before `:`.
  const colonIndex = qualifier.indexOf(':');
  const beforeColon =
    colonIndex >= 0 ? qualifier.slice(0, colonIndex) : qualifier;
  const lastSlash = beforeColon.lastIndexOf('/');
  if (lastSlash >= 0 && lastSlash < beforeColon.length - 1) {
    return beforeColon.slice(lastSlash + 1);
  }
  return entry.packageName || beforeColon || 'Resources';
}

/**
 * Pick the qualifier string for an entry. Prefers the explicit
 * `qualifiedName`; falls back to a synthesised `packageName:className`
 * pair so partial / hand-built manifests still work in tests.
 */
function entryQualifier(entry: SmrtManifestEntryLike): string {
  if (entry.qualifiedName) return entry.qualifiedName;
  if (entry.packageName) return `${entry.packageName}:${entry.className}`;
  return entry.className;
}

/**
 * Walk a SMRT manifest and emit the `NavSection[]` shape that
 * `<NavTree items={...}>` and `RoleConfig.sections` consume.
 *
 * Algorithm:
 *   1. Drop collection classes (`*Collection` / `extends: 'SmrtCollection'`).
 *   2. Drop entries marked `@smrt({ visibility: 'internal' | 'test' })` —
 *      they're plumbing / fixtures and never belong in admin nav.
 *   3. Drop entries that don't expose a REST `list` route (`@smrt({ api: false })`,
 *      `include` without `list`, or `exclude` containing `list`).
 *   4. Drop STI subtypes that share their parent's `collection` value —
 *      the REST endpoint at the shared collection URL is polymorphic and
 *      shows all subtypes through one link.
 *   5. If `permittedResources` is provided, drop entries whose qualified
 *      name isn't in the list. Otherwise keep all remaining entries.
 *   6. Group remaining entries by their resolved section title.
 *   4. For each entry, emit a `NavItem` with:
 *       - `label` = `decoratorConfig.ui.label` ?? `pluralizeClassName(className)`
 *       - `href`  = `${basePath}/${collection}` (defaults to `/api/v1/{collection}`)
 *                   falling back to `${basePath}/{kebab-case-class}` if the
 *                   manifest entry omits `collection`.
 *       - `icon`  = `decoratorConfig.ui.icon` if present.
 *   5. Sort items inside each section by label, then sort sections by title.
 *      The result is fully deterministic given a manifest input.
 *
 * @example Plug into RoleShell
 * ```ts
 * import { manifest } from '@my-app/manifest';
 * import { navTreeFromManifest } from '@happyvertical/smrt-svelte/workspace';
 *
 * const sections = navTreeFromManifest(manifest, {
 *   sectionHints: {
 *     '@happyvertical/smrt-content': 'Content',
 *     '@happyvertical/smrt-commerce': 'Commerce',
 *   },
 * });
 * const roles: RoleConfig[] = [
 *   { id: 'admin', label: 'Admin', sections },
 * ];
 * ```
 *
 * @example Per-role filtering
 * ```ts
 * const editor = navTreeFromManifest(manifest, {
 *   permittedResources: [
 *     '@happyvertical/smrt-content:Article',
 *     '@happyvertical/smrt-content:Document',
 *   ],
 * });
 * // editor: [{ label: 'Content', children: [Articles, Documents] }]
 * ```
 *
 * @example Unprefixed hrefs
 * ```ts
 * const sections = navTreeFromManifest(manifest, { basePath: '' });
 * // items[0].href === '/articles' (not '/api/v1/articles')
 * ```
 */
export function navTreeFromManifest(
  manifest: SmrtManifestLike,
  options: NavTreeFromManifestOptions = {},
): NavSection[] {
  const { permittedResources, sectionHints, basePath = '/api/v1' } = options;
  const permitted = permittedResources
    ? new Set(permittedResources)
    : undefined;

  // Group items by their resolved section title. Map preserves insertion
  // order, but we sort the final output anyway so callers don't have to
  // care about it.
  const sectionMap = new Map<string, NavItem[]>();

  for (const entry of Object.values(manifest.objects)) {
    if (looksLikeCollectionClass(entry)) continue;
    if (!isPublicEntry(entry)) continue;
    if (!hasListRoute(entry)) continue;
    if (looksLikeStiSubtypeOfParentRoute(entry, manifest)) continue;

    const qualifier = entryQualifier(entry);
    if (permitted && !permitted.has(qualifier)) continue;

    const ui = entry.decoratorConfig?.ui;
    const label = ui?.label ?? pluralizeClassName(entry.className);
    const slug = entry.collection ?? classNameToKebab(entry.className);
    const href = `${basePath}/${slug}`;

    const item: NavItem = {
      href,
      label,
    };
    if (ui?.icon) item.icon = ui.icon;

    const sectionTitle = deriveSectionTitle(entry, qualifier, sectionHints);
    const bucket = sectionMap.get(sectionTitle);
    if (bucket) {
      bucket.push(item);
    } else {
      sectionMap.set(sectionTitle, [item]);
    }
  }

  // Deterministic ordering: sort items inside each section by label, then
  // sort sections by title. Using `localeCompare` for predictable
  // cross-locale behaviour without surprises around case.
  const sections: NavSection[] = [];
  for (const [title, items] of sectionMap) {
    items.sort((a, b) => a.label.localeCompare(b.label));
    sections.push({
      href: `#${title.toLowerCase().replace(/\s+/g, '-')}`,
      label: title,
      children: items,
    });
  }
  sections.sort((a, b) => a.label.localeCompare(b.label));

  return sections;
}
