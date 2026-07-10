import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import SettingsCatalog from '../SettingsCatalog.svelte';
import type { SettingsCatalogItem } from '../types.js';

interface TestItem extends SettingsCatalogItem {
  template: string;
}

const first: TestItem = {
  id: 'first',
  label: 'First setting',
  description: 'First description',
  eyebrow: 'General',
  status: 'Default',
  template: 'First template',
};

const second: TestItem = {
  id: 'second',
  label: 'Second setting',
  description: 'Second description',
  eyebrow: 'Advanced',
  status: 'Override',
  template: 'Second template',
};

function detailSnippet() {
  return createRawSnippet<[{ item: TestItem }]>((context) => ({
    render: () =>
      `<h2>${context().item.label} editor</h2><p>${context().item.template}</p>`,
  }));
}

describe('SettingsCatalog', () => {
  it('renders a compact page, selected detail, and query-preserving links', () => {
    const { container } = render(SettingsCatalog<TestItem>, {
      props: {
        baseUrl: '/settings/prompts',
        detail: detailSnippet(),
        preservedParams: { locale: 'fr-CA' },
        page: {
          items: [first, second],
          selected: second,
          query: 'tenant copy',
          page: 2,
          pageSize: 2,
          total: 6,
        },
      },
    });

    expect(screen.getByRole('searchbox')).toHaveValue('tenant copy');
    expect(
      screen.getByRole('heading', { name: 'Second setting editor' }),
    ).toBeInTheDocument();
    expect(container.querySelector('a[aria-current="true"]')).toHaveAttribute(
      'href',
      '/settings/prompts?locale=fr-CA&q=tenant+copy&page=2&selected=second',
    );
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/settings/prompts?locale=fr-CA&q=tenant+copy',
    );
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/settings/prompts?locale=fr-CA&q=tenant+copy&page=3',
    );
  });

  it('renders an empty state and remains axe-clean', async () => {
    const { container } = render(SettingsCatalog<TestItem>, {
      props: {
        baseUrl: '/settings/prompts',
        detail: detailSnippet(),
        page: {
          items: [],
          selected: null,
          query: 'missing',
          page: 1,
          pageSize: 50,
          total: 0,
        },
      },
    });

    expect(
      screen.getByText('No settings match this search.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Select a setting to edit.')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
