import type { Cookbook } from '@happyvertical/smrt-types';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { narrowCatalog } from '../catalog.js';
import type { CookbookCatalog } from '../types.js';
import Harness from './app-harness.svelte';
import { readFixture, workspaceCatalog } from './workspace-catalog.js';

let catalog: CookbookCatalog;
const cookbook = readFixture('bakery') as Cookbook;
beforeAll(async () => {
  catalog = narrowCatalog(await workspaceCatalog(), cookbook);
}, 120_000);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CookbookApp', () => {
  it("lists the cookbook's sections in the sidebar and renders the section page", async () => {
    render(Harness, { cookbook, catalog, sectionId: 'custom:shop' });

    // navMode sections: one link per section, named as the layout names them.
    await screen.findByRole('heading', { level: 1, name: 'Shop' });
    for (const label of [
      'Shop',
      'Wholesale',
      'Kitchen',
      'Buying',
      'Accounting',
    ]) {
      expect(
        screen.getAllByRole('link', { name: label }).length,
      ).toBeGreaterThan(0);
    }
    // Section links go to the section pages.
    expect(
      screen
        .getAllByRole('link', { name: 'Wholesale' })[0]
        ?.getAttribute('href'),
    ).toBe('/s/custom-wholesale/');

    // The section page: its title, and the entries as shortcut cards once the
    // overview's widgets have loaded.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Shop' }),
    ).toBeTruthy();
    await waitFor(() => {
      const main = document.querySelector(
        'main.cookbook-section',
      ) as HTMLElement;
      expect(within(main).getByText('Orders')).toBeTruthy();
      expect(within(main).getByText('Customers')).toBeTruthy();
    });
    const orders = within(
      document.querySelector('main.cookbook-section') as HTMLElement,
    ).getByText('Orders');
    expect(orders.closest('a')?.getAttribute('href')).toBe(
      '/m/commerce/Order/',
    );
  });

  it('applies the brand theme from the cookbook', async () => {
    render(Harness, { cookbook, catalog, sectionId: 'custom:shop' });
    await screen.findByRole('heading', { level: 1, name: 'Shop' });
    await waitFor(() => {
      expect(
        document.querySelector('[data-theme="cookbook-brand-b45309-georgia"]'),
      ).toBeTruthy();
    });
  });

  it('hands overview edits to oncookbookchange', async () => {
    const changes: Cookbook[] = [];
    render(Harness, {
      cookbook,
      catalog,
      sectionId: 'custom:shop',
      oncookbookchange: (next: Cookbook) => changes.push(next),
    });
    await screen.findByRole('heading', { level: 1, name: 'Shop' });
    await fireEvent.click(screen.getByText('save-override'));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.overviews?.['custom:shop']).toMatchObject({
      version: 1,
      added: [{ id: 'w1', type: 'note' }],
    });
    // The rest of the cookbook is untouched, layout included.
    expect(changes[0]?.layout).toEqual(cookbook.layout);
    expect(changes[0]?.recipes).toEqual(cookbook.recipes);
    // Reset stores nothing: the key disappears.
    await fireEvent.click(screen.getByText('reset-override'));
    expect(changes[1]?.overviews).toBeUndefined();
  });

  it('says so when the section is not in the app', async () => {
    render(Harness, { cookbook, catalog, sectionId: 'custom:missing' });
    expect(await screen.findByText('Section not found')).toBeTruthy();
  });
});
