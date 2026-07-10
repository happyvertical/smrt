export interface SettingsCatalogItem {
  id: string;
  label: string;
  description?: string;
  eyebrow?: string;
  status?: string;
}

export interface SettingsCatalogPage<
  T extends SettingsCatalogItem,
  D extends { id: string } = T,
> {
  items: T[];
  selected: D | null;
  query: string;
  page: number;
  pageSize: number;
  total: number;
}

export interface PaginateSettingsCatalogOptions<T extends SettingsCatalogItem> {
  query?: string | null;
  page?: number | null;
  pageSize?: number | null;
  selectedId?: string | null;
  getSearchText?: (item: T) => string;
}
