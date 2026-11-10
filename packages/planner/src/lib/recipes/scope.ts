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

/**
 * A model page's menu words: the label its menu entry shows (the layout's
 * rename, a cookbook's or the visitor's, else the added recipe entry's own)
 * and its declared New noun. `heading` is that label unless it only repeats
 * the model's name. The static app reads the rendered menu (`ModelPage`); the
 * mount, outside the shell's context, reads the same sources here.
 */
export function menuEntryWords(
  model: { id: string; name: string },
  itemId: string,
  view: string | undefined,
  added: readonly (Pick<RecipeNavTarget, 'key' | 'label' | 'noun'> & {
    model: { id: string };
  })[],
  layout:
    | { items?: Record<string, { label?: string } | undefined> }
    | undefined,
  humanize: (name: string) => string,
): { label?: string; heading?: string; noun?: string } {
  const entry = added.find((e) => e.model.id === model.id && e.key === view);
  const label = layout?.items?.[itemId]?.label?.trim() || entry?.label;
  if (!label) return {};
  return {
    label,
    heading:
      label.toLowerCase() === humanize(model.name).toLowerCase()
        ? undefined
        : label,
    ...(entry?.noun ? { noun: entry.noun } : {}),
  };
}
