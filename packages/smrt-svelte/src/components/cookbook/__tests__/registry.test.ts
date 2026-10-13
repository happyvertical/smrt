import { describe, expect, it } from 'vitest';
import type { ShortcutEntry } from '../../overview/widgets/data.js';
import { createCookbookRegistry } from '../registry.js';

const sections = [
  {
    id: 'section:sales',
    items: [
      {
        id: 'a',
        label: 'Orders',
        item: { href: '/m/commerce/Order/', icon: 'receipt' },
      },
      { id: 'b', label: 'Customers', item: { href: '/m/commerce/Customer/' } },
    ],
  },
];
const ctx = { overviewId: 'section:sales', sections };

async function loadShortcuts(
  shortcuts?: (
    ctx: unknown,
    defaults: ShortcutEntry[],
  ) => Promise<ShortcutEntry[]>,
) {
  const { registry } = await createCookbookRegistry({
    loaders: shortcuts ? { shortcuts } : undefined,
  });
  const load = registry.get('shortcuts')?.load;
  if (!load) throw new Error('shortcuts is not registered');
  return (await load({}, ctx)) as {
    items: (ShortcutEntry & { id: string })[];
  };
}

describe('createCookbookRegistry shortcuts loader (#3888)', () => {
  it('keeps the default entries when the host supplies no loader', async () => {
    const data = await loadShortcuts();
    expect(data.items.map((i) => [i.label, i.href, i.count])).toEqual([
      ['Orders', '/m/commerce/Order/', undefined],
      ['Customers', '/m/commerce/Customer/', undefined],
    ]);
  });

  it('lets a host loader augment the defaults with counts', async () => {
    let received: ShortcutEntry[] = [];
    const data = await loadShortcuts(async (_ctx, defaults) => {
      received = defaults;
      return defaults.map((entry) => ({
        ...entry,
        count: entry.label === 'Orders' ? 12 : 0,
      }));
    });
    expect(received.map((e) => e.href)).toEqual([
      '/m/commerce/Order/',
      '/m/commerce/Customer/',
    ]);
    expect(data.items.map((i) => [i.label, i.count])).toEqual([
      ['Orders', 12],
      ['Customers', 0],
    ]);
    expect(data.items[0]?.icon).toBe('receipt');
  });

  it('falls back to the defaults when the host loader throws', async () => {
    const data = await loadShortcuts(async () => {
      throw new Error('count query failed');
    });
    expect(data.items.map((i) => i.label)).toEqual(['Orders', 'Customers']);
    expect(data.items.every((i) => i.count === undefined)).toBe(true);
  });
});
