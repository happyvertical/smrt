import { describe, expect, it } from 'vitest';
import { paginateSettingsCatalog } from '../catalog.js';

const items = Array.from({ length: 125 }, (_, index) => ({
  id: `setting-${index + 1}`,
  label: `Setting ${index + 1}`,
  description: index % 2 === 0 ? 'Alpha group' : 'Beta group',
}));

describe('paginateSettingsCatalog', () => {
  it('filters before paging and keeps the DOM-sized slice bounded', () => {
    const page = paginateSettingsCatalog(items, {
      query: 'alpha',
      page: 2,
      pageSize: 20,
    });

    expect(page.total).toBe(63);
    expect(page.items).toHaveLength(20);
    expect(page.page).toBe(2);
    expect(page.items.every((item) => item.description === 'Alpha group')).toBe(
      true,
    );
  });

  it('clamps invalid pages and page sizes', () => {
    const page = paginateSettingsCatalog(items, {
      page: 999,
      pageSize: 1_000,
    });

    expect(page.pageSize).toBe(100);
    expect(page.page).toBe(2);
    expect(page.items).toHaveLength(25);
  });

  it('selects an explicit item or falls back to the first visible item', () => {
    expect(
      paginateSettingsCatalog(items, { selectedId: 'setting-73' }).selected?.id,
    ).toBe('setting-73');
    expect(paginateSettingsCatalog(items).selected?.id).toBe('setting-1');
  });

  it('keeps a very large code-first registry to one bounded result page', () => {
    const largeRegistry = Array.from({ length: 10_000 }, (_, index) => ({
      id: `large-${index}`,
      label: `Large setting ${index}`,
    }));

    const page = paginateSettingsCatalog(largeRegistry, {
      page: 100,
      pageSize: 50,
    });

    expect(page.total).toBe(10_000);
    expect(page.items).toHaveLength(50);
    expect(page.items[0]?.id).toBe('large-4950');
  });
});
