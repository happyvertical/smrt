import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import type { Recipe } from '../recipes/index.ts';
import {
  legacyNavSectionKeys,
  navItemId,
  navSectionOf,
  recipeNav,
  recipes,
} from '../recipes/index.ts';

const PREFIX = 'section:';

/**
 * Nav sections used to be one per group/recipe (`section:commerce.customers`,
 * `section:products`); recipes now suggest shared ones (`section:sales`).
 * Rewrites a saved layout's ids from the old keys to the new, once, in the
 * loader. Idempotent: new ids are not old keys. Section-level hides of a
 * renamed section are dropped (the merged section may hold other recipes'
 * items, so one old hide must not hide them); everything else is mapped and
 * de-duplicated, and ids nothing refers to any more are harmless to the shell.
 */
export function migrateLegacySections(
  layout: ShellLayout,
  keys: Record<string, string> = legacyNavSectionKeys(recipes),
): ShellLayout {
  const olds = Object.keys(keys).sort((a, b) => b.length - a.length);
  if (!olds.length) return layout;

  /** `section:<old>` -> `section:<new>`; `section:<old>:rest` likewise. */
  const mapId = (id: string): string => {
    if (!id.startsWith(PREFIX)) return id;
    const rest = id.slice(PREFIX.length);
    for (const old of olds) {
      if (rest === old) return `${PREFIX}${keys[old]}`;
      if (rest.startsWith(`${old}:`)) {
        return `${PREFIX}${keys[old]}${rest.slice(old.length)}`;
      }
    }
    return id;
  };
  const isRenamedSection = (id: string) =>
    id.startsWith(PREFIX) && olds.includes(id.slice(PREFIX.length));
  const unique = (ids: string[]) => [...new Set(ids)];

  const next: ShellLayout = { ...layout };
  if (layout.sectionOrder)
    next.sectionOrder = unique(layout.sectionOrder.map(mapId));
  if (layout.hidden) {
    next.hidden = unique(
      layout.hidden.filter((id) => !isRenamedSection(id)).map(mapId),
    );
  }
  if (layout.itemOrder) {
    const merged: Record<string, string[]> = {};
    for (const [section, ids] of Object.entries(layout.itemOrder)) {
      const key = mapId(section);
      merged[key] = unique([...(merged[key] ?? []), ...ids.map(mapId)]);
    }
    next.itemOrder = merged;
  }
  if (layout.moved) {
    next.moved = Object.fromEntries(
      Object.entries(layout.moved).map(([item, to]) => [
        mapId(item),
        mapId(to),
      ]),
    );
  }
  return next;
}

/**
 * Old item ids were `section:<nav>:<pkg>:<Model>:<label>` (features
 * `section:more:<pkg>:<Model>`); they are now `item:<pkg>:<Model>[:<key>]`
 * (`navItemId`). Section ids (`section:<id>`, no further parts) are unchanged.
 * Rewrites every id the layout holds (itemOrder, hidden, moved, items), keys
 * and values alike. An entry declaring a `key` is matched exactly through the
 * recipes; any other old id maps by its package and model. Idempotent (`item:`
 * ids are left alone) and unknown ids stay as they are.
 */
export function migrateNavItemIds(
  layout: ShellLayout,
  source: readonly Recipe[] = recipes,
): ShellLayout {
  const keyed = new Map<string, string>();
  for (const recipe of source) {
    const section = navSectionOf(recipe).id;
    for (const entry of recipeNav(recipe)) {
      if (!entry.key) continue;
      keyed.set(
        `${PREFIX}${section}:${entry.packageId}:${entry.model.name}:${entry.label}`,
        navItemId(entry.packageId, entry.model.name, entry.key),
      );
    }
  }
  const mapId = (id: string): string => {
    const exact = keyed.get(id);
    if (exact) return exact;
    if (!id.startsWith(PREFIX)) return id;
    // section : pkg : Model [: label]; a section id has no further parts.
    const parts = id.slice(PREFIX.length).split(':');
    if (parts.length < 3 || !parts[1] || !parts[2]) return id;
    return navItemId(parts[1], parts[2]);
  };
  const unique = (ids: string[]) => [...new Set(ids)];
  const remap = <T>(record: Record<string, T>, value: (v: T) => T) => {
    const out: Record<string, T> = {};
    for (const [key, v] of Object.entries(record)) {
      const next = mapId(key);
      if (!(next in out)) out[next] = value(v);
    }
    return out;
  };

  const next: ShellLayout = { ...layout };
  if (layout.hidden) next.hidden = unique(layout.hidden.map(mapId));
  if (layout.itemOrder) {
    next.itemOrder = remap(layout.itemOrder, (ids) => unique(ids.map(mapId)));
  }
  if (layout.moved) next.moved = remap(layout.moved, mapId);
  if (layout.items) next.items = remap(layout.items, (item) => item);
  return next;
}
