import type { RecipeNavTarget } from './index.ts';

/**
 * Which rows a model page lists. A keyed nav entry with a `filter` lists only
 * the rows matching it (`equals`); the model's plain entry lists the rest
 * (`notIn`) once such an entry's recipe is added, so a row shows in one place.
 */
export interface RowScope {
  field: string;
  equals?: string;
  notIn?: string[];
}

type ScopedEntry = Pick<RecipeNavTarget, 'key' | 'filter'> & {
  model: { id: string };
};

/**
 * The scope of a page: `view` is the entry key in the path (none for the
 * plain entry); `added` are the nav entries of the added recipes.
 */
export function pageScope(
  modelId: string,
  view: string | undefined,
  added: readonly ScopedEntry[],
): RowScope | undefined {
  const here = added.filter((e) => e.model.id === modelId && e.filter);
  if (view) {
    const filter = here.find((e) => e.key === view)?.filter;
    return filter ? { field: filter.field, equals: filter.value } : undefined;
  }
  const first = here[0]?.filter;
  if (!first) return undefined;
  const claimed = here
    .map((e) => e.filter)
    .filter((f) => f?.field === first.field)
    .map((f) => String(f?.value));
  return { field: first.field, notIn: [...new Set(claimed)] };
}

export function inScope(
  scope: RowScope | undefined,
  row: Record<string, unknown>,
): boolean {
  if (!scope) return true;
  const value = String(row[scope.field] ?? '');
  if (scope.equals !== undefined) return value === scope.equals;
  return !scope.notIn?.includes(value);
}

/** Values a row created from the page carries, so it stays in view. */
export function scopePreset(
  scope: RowScope | undefined,
): Record<string, unknown> {
  return scope?.equals !== undefined ? { [scope.field]: scope.equals } : {};
}
