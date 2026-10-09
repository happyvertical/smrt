import { describe, expect, it, vi } from 'vitest';
import {
  createModelProviders,
  createNavigationProvider,
  type PaletteManifestLike,
  paletteModelsFromManifest,
} from '../providers.js';
import type { PaletteItem, PaletteProvider } from '../types.js';

const text = (extra: Record<string, unknown> = {}) => ({
  type: 'text',
  ...extra,
});

const manifest: PaletteManifestLike = {
  objects: {
    '@acme/billing:SalesInvoice': {
      className: 'SalesInvoice',
      qualifiedName: '@acme/billing:SalesInvoice',
      collection: 'sales-invoices',
      fields: {
        id: text(),
        number: text(),
        status: text({ enum: ['open', 'paid'] }),
        taxId: text({ sensitive: true }),
        total: { type: 'integer' },
      },
      decoratorConfig: {},
    },
    '@acme/billing:Customer': {
      className: 'Customer',
      qualifiedName: '@acme/billing:Customer',
      collection: 'customers',
      fields: { name: text(), title: text(), email: text() },
      decoratorConfig: { ui: { label: 'Clients' } },
    },
    '@acme/billing:AuditEntry': {
      className: 'AuditEntry',
      qualifiedName: '@acme/billing:AuditEntry',
      collection: 'audit-entries',
      fields: { name: text() },
      decoratorConfig: { api: { exclude: ['create'] } },
    },
    '@acme/billing:Plumbing': {
      className: 'Plumbing',
      qualifiedName: '@acme/billing:Plumbing',
      collection: 'plumbing',
      fields: { name: text() },
      decoratorConfig: {},
      visibility: 'internal',
    },
    '@acme/billing:CustomerCollection': {
      className: 'CustomerCollection',
      collection: 'customers',
      extends: 'SmrtCollection',
      fields: {},
      decoratorConfig: {},
    },
    '@acme/billing:Untitled': {
      className: 'Untitled',
      qualifiedName: '@acme/billing:Untitled',
      collection: 'untitled',
      fields: { kind: text() },
      decoratorConfig: {},
    },
  },
};

const ctx = () => ({ signal: new AbortController().signal, limit: 8 });
const resolveItems = async (provider: PaletteProvider) =>
  (await provider.items?.({ signal: new AbortController().signal })) ?? [];
const search = async (provider: PaletteProvider, query: string) =>
  (await provider.search?.(query, ctx())) ?? [];

describe('navigation provider', () => {
  it('flattens nav, children and groups, once each, with breadcrumbs', async () => {
    const provider = createNavigationProvider({
      nav: () => [
        {
          href: '/home',
          label: 'Home',
          icon: 'home',
          children: [{ href: '/home/news', label: 'News' }],
        },
        { href: '/home', label: 'Home again' },
      ],
      groups: [
        {
          heading: 'Sales',
          items: [
            {
              id: 'inv',
              href: '/invoices',
              label: 'Invoices',
              description: 'Billing',
            },
          ],
        },
      ],
    });
    const items = (await resolveItems(provider)) as PaletteItem[];
    expect(items.map((i) => [i.title, i.subtitle, i.href])).toEqual([
      ['Home', undefined, '/home'],
      ['News', 'Home', '/home/news'],
      ['Invoices', 'Sales', '/invoices'],
    ]);
    expect(items[2]).toMatchObject({ id: 'nav:inv', keywords: ['Billing'] });
    expect(items[0]).toMatchObject({ icon: 'home', kind: 'navigation' });
    expect(provider).toMatchObject({ id: 'navigation', label: 'Go to' });
  });

  it('reads reactive getters on every open', async () => {
    let nav = [{ href: '/a', label: 'A' }];
    const provider = createNavigationProvider({ nav: () => nav });
    expect(await resolveItems(provider)).toHaveLength(1);
    nav = [...nav, { href: '/b', label: 'B' }];
    expect(await resolveItems(provider)).toHaveLength(2);
  });
});

describe('model metadata from the manifest', () => {
  const models = paletteModelsFromManifest({ manifest });

  it('lists only navigable models, sorted by label', () => {
    expect(models.map((m) => m.entry.className)).toEqual([
      'AuditEntry',
      'Customer',
      'SalesInvoice',
      'Untitled',
    ]);
  });

  it('derives labels, creatability and search fields', () => {
    const byName = Object.fromEntries(
      models.map((m) => [m.entry.className, m]),
    );
    expect(byName.Customer).toMatchObject({
      label: 'Clients',
      singular: 'Customer',
      searchFields: ['title'],
      creatable: true,
    });
    expect(byName.SalesInvoice).toMatchObject({
      label: 'Sales invoices',
      singular: 'Sales invoice',
      collection: 'sales-invoices',
      searchFields: ['number'],
      titleField: 'number',
    });
    expect(byName.AuditEntry.creatable).toBe(false);
    // Sensitive and enumerated text is never searched; no title field, no search.
    expect(byName.Untitled.searchFields).toEqual([]);
  });

  it('honours overrides, the per-model field count and the allow-list', () => {
    const custom = paletteModelsFromManifest({
      manifest,
      fieldsPerModel: 2,
      searchFields: { Customer: ['email', 'name', 'title'] },
      permittedResources: ['@acme/billing:Customer'],
    });
    expect(custom).toHaveLength(1);
    expect(custom[0].searchFields).toEqual(['email', 'name']);
  });
});

describe('model commands provider', () => {
  it('offers New <noun> for creatable models, with an href', async () => {
    const [commands] = createModelProviders({
      manifest,
      pagesBasePath: '/app',
    });
    const items = await resolveItems(commands);
    expect(items.map((i) => i.title)).toEqual([
      'New customer',
      'New sales invoice',
      'New untitled',
    ]);
    expect(items[1]).toMatchObject({
      href: '/app/sales-invoices/new',
      kind: 'create',
      icon: 'add',
      subtitle: 'Sales invoices',
    });
    expect(commands).toMatchObject({ id: 'models.commands', label: 'Create' });
  });

  it('can add list rows and take custom hrefs and titles', async () => {
    const [commands] = createModelProviders({
      manifest,
      lists: true,
      hrefs: {
        create: (m) =>
          m.entry.className === 'Customer' ? null : `/c/${m.collection}`,
        list: (m) => `/l/${m.collection}`,
      },
      createTitle: (m) => `Add ${m.singular}`,
      listTitle: (m) => `Open ${m.label}`,
    });
    const titles = (await resolveItems(commands)).map((i) => i.title);
    expect(titles).toContain('Open Clients');
    expect(titles).toContain('Add Sales invoice');
    expect(titles).not.toContain('Add Customer');
  });
});

describe('model records provider', () => {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    'sales-invoices': [
      { id: 'i1', number: 'INV-1' },
      { id: 'i2', number: 'INV-2' },
      { id: 'i3', number: 'INV-3' },
    ],
    customers: [{ id: 'c1', title: 'Acme Inc', name: 'acme' }],
    'audit-entries': [],
  };

  function fetchFake(status: Record<string, number> = {}) {
    return vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      const collection = path.split('?')[0].split('/').pop() as string;
      const code = status[collection] ?? 200;
      return new Response(JSON.stringify(rows[collection] ?? []), {
        status: code,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  it('queries each searchable model with a LIKE filter and interleaves', async () => {
    const fetchSpy = fetchFake();
    const [, records] = createModelProviders({
      manifest,
      fetch: fetchSpy as unknown as typeof fetch,
      perModelLimit: 2,
      pagesBasePath: '/app',
    });
    const results = await search(records, 'in%c');
    const urls = fetchSpy.mock.calls.map(([url]) =>
      decodeURIComponent(String(url)),
    );
    expect(urls).toHaveLength(3);
    expect(urls).toContain('/api/v1/customers?title[like]=%inc%&limit=2');
    expect(urls).toContain('/api/v1/sales-invoices?number[like]=%inc%&limit=2');
    // Round robin across models: Customers first (sorted by label), not 3 invoices.
    expect(results.map((r) => r.title)).toEqual(['Acme Inc', 'INV-1', 'INV-2']);
    expect(results[0]).toMatchObject({
      id: '@acme/billing:Customer:c1',
      href: '/app/customers/c1',
      subtitle: 'Customer',
      kind: 'record',
    });
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      credentials: 'same-origin',
    });
  });

  it('treats forbidden and missing routes as no results', async () => {
    const [, records] = createModelProviders({
      manifest,
      fetch: fetchFake({
        customers: 403,
        'sales-invoices': 404,
      }) as unknown as typeof fetch,
    });
    expect(await search(records, 'acme')).toEqual([]);
  });

  it('fails when every request fails, but not when only some do', async () => {
    const down = vi.fn(async () => new Response('x', { status: 500 }));
    const [, allDown] = createModelProviders({
      manifest,
      fetch: down as unknown as typeof fetch,
    });
    await expect(search(allDown, 'acme')).rejects.toThrow(/failed \(500\)/);

    const [, partial] = createModelProviders({
      manifest,
      fetch: fetchFake({ customers: 500 }) as unknown as typeof fetch,
    });
    const results = await search(partial, 'inv');
    expect(
      results.every((r) => r.id.startsWith('@acme/billing:SalesInvoice')),
    ).toBe(true);
  });

  it('restricts models, caps their number and swaps the request', async () => {
    const searchRows = vi.fn(async ({ model }) => rows[model.collection] ?? []);
    const [, records] = createModelProviders({
      manifest,
      searchModels: ['Customer', 'AuditEntry'],
      searchRows,
    });
    const results = await search(records, 'acme');
    expect(searchRows).toHaveBeenCalledTimes(2);
    expect(searchRows.mock.calls[0][0]).toMatchObject({
      field: expect.any(String),
      query: 'acme',
      limit: 3,
    });
    expect(results.map((r) => r.title)).toEqual(['Acme Inc']);

    const [, capped] = createModelProviders({
      manifest,
      maxModels: 1,
      searchRows,
    });
    searchRows.mockClear();
    await search(capped, 'acme');
    expect(searchRows).toHaveBeenCalledTimes(1);
  });

  it('skips rows without an id or a destination', async () => {
    const [, records] = createModelProviders({
      manifest,
      searchModels: ['Customer'],
      searchRows: async () => [{ title: 'No id' }, { id: 'c9', title: 'Gone' }],
      hrefs: { record: (_m, row) => (row.id === 'c9' ? null : '/x') },
    });
    expect(await search(records, 'x')).toEqual([]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const [, records] = createModelProviders({
      manifest,
      searchRows: async ({ signal }) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
        return [];
      },
    });
    await expect(
      records.search?.('acme', { signal: controller.signal, limit: 8 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
