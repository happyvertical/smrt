import type { CatalogPackage } from '../catalog/types.ts';

/** The URL query parameter that carries the selection: `?p=products,sales`. */
export const SELECTION_PARAM = 'p';

/** Parse the selection out of a query string, keeping only known package ids. */
export function parseSelection(
  search: string,
  known: ReadonlySet<string>,
): string[] {
  const value = new URLSearchParams(search).get(SELECTION_PARAM) ?? '';
  return normalize(value.split(',').filter((id) => known.has(id)));
}

/** Sorted and de-duplicated, so the same selection is always the same URL. */
export function normalize(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** `?p=a,b`, or the empty string for an empty selection. */
export function selectionQuery(ids: readonly string[]): string {
  return ids.length ? `?${SELECTION_PARAM}=${normalize(ids).join(',')}` : '';
}

/** Append the selection to an in-app path so it survives navigation. */
export function withSelection(path: string, ids: readonly string[]): string {
  return `${path}${selectionQuery(ids)}`;
}

/** `ids` plus everything they transitively depend on, as a sorted set. */
export function withDependencies(
  ids: Iterable<string>,
  packages: ReadonlyMap<string, CatalogPackage>,
): string[] {
  const result = new Set<string>();
  const visit = (id: string) => {
    const pkg = packages.get(id);
    if (!pkg || result.has(id)) return;
    result.add(id);
    for (const dependency of pkg.dependencies) visit(dependency);
  };
  for (const id of ids) visit(id);
  return normalize(result);
}

/** Ids of the selected packages that depend (directly) on `id`. */
export function requiredBy(
  id: string,
  selected: readonly string[],
  packages: ReadonlyMap<string, CatalogPackage>,
): string[] {
  return selected.filter(
    (other) => other !== id && packages.get(other)?.dependencies.includes(id),
  );
}
