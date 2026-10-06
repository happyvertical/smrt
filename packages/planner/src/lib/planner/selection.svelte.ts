import { base } from '$app/paths';
import { catalog } from '../catalog/index.ts';
import {
  normalize,
  parseSelection,
  requiredBy,
  withDependencies,
  withSelection,
} from './selection.ts';

const packages = new Map(catalog.packages.map((pkg) => [pkg.id, pkg]));
const known = new Set(packages.keys());

/**
 * The visitor's chosen packages: the one piece of state the control panel, the
 * generated navigation and (later) the chat assistant all read and write.
 *
 * The URL (`?p=...`) is the persisted form; the layout keeps the two in sync.
 * Anything that changes the selection goes through `add`, `remove` or
 * `apply`, so a future chat transport can drive it exactly like the panel.
 */
class Selection {
  ids = $state<string[]>([]);

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /** Selected packages that need `id`; non-empty means it cannot be removed. */
  requiredBy(id: string): string[] {
    return requiredBy(id, this.ids, packages);
  }

  /** Replace the selection from a URL query string. */
  fromSearch(search: string): void {
    this.ids = withDependencies(parseSelection(search, known), packages);
  }

  /** Select packages, pulling in their dependencies. */
  add(...ids: string[]): void {
    this.ids = withDependencies([...this.ids, ...ids], packages);
  }

  /** Deselect packages; ones other selected packages need are kept. */
  remove(...ids: string[]): void {
    const removing = new Set(ids);
    let remaining = this.ids.filter((id) => !removing.has(id));
    // A package whose dependency was just removed would be orphaned; keep the
    // dependency instead of silently dropping the dependant.
    remaining = withDependencies(remaining, packages);
    this.ids = normalize(remaining);
  }

  toggle(id: string): void {
    if (this.has(id)) this.remove(id);
    else this.add(id);
  }

  /** Apply an `{ add, remove }` change (the shape the chat assistant emits). */
  apply(change: { add?: string[]; remove?: string[] }): void {
    this.add(...(change.add ?? []).filter((id) => known.has(id)));
    this.remove(...(change.remove ?? []));
  }

  /** An in-app path (`/m/products/Product/`) carrying the current selection. */
  href(path: string): string {
    return withSelection(`${base}${path}`, this.ids);
  }

  clear(): void {
    this.ids = [];
  }
}

export const selection = new Selection();
