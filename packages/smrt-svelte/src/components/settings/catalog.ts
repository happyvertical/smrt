import type {
  PaginateSettingsCatalogOptions,
  SettingsCatalogItem,
  SettingsCatalogPage,
} from './types.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Search and page an in-memory settings registry before it reaches the DOM.
 *
 * Applications backed by a database can construct {@link SettingsCatalogPage}
 * directly from their server-side query instead. This helper is for code-first
 * registries that already exist in memory, such as prompt and language
 * definitions.
 */
export function paginateSettingsCatalog<T extends SettingsCatalogItem>(
  source: readonly T[],
  options: PaginateSettingsCatalogOptions<T> = {},
): SettingsCatalogPage<T> {
  const query = options.query?.trim() ?? '';
  const needle = query.toLocaleLowerCase();
  const getSearchText = options.getSearchText ?? defaultSearchText;
  const filtered = needle
    ? source.filter((item) =>
        getSearchText(item).toLocaleLowerCase().includes(needle),
      )
    : [...source];
  const pageSize = clampInteger(
    options.pageSize,
    1,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInteger(options.page, 1, totalPages, 1);
  const offset = (page - 1) * pageSize;
  const items = filtered.slice(offset, offset + pageSize);
  const selected =
    (options.selectedId
      ? filtered.find((item) => item.id === options.selectedId)
      : null) ??
    items[0] ??
    null;

  return { items, selected, query, page, pageSize, total };
}

function defaultSearchText(item: SettingsCatalogItem): string {
  return [item.label, item.description, item.eyebrow, item.status]
    .filter(Boolean)
    .join(' ');
}

function clampInteger(
  value: number | null | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}
