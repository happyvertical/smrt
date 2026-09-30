/** Link tabs: a navigation row of URLs with overflow, badges, active-in-view. */
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Tabs from '../Tabs.svelte';
import { splitTabs } from '../tabs-overflow.js';
import type { Tab } from '../types.js';

const TABS: Tab[] = [
  { id: 'article', label: 'Article', href: '/c/1' },
  { id: 'images', label: 'Images', href: '/c/1/images', badge: 3 },
  { id: 'videos', label: 'Videos', href: '/c/1/videos' },
  { id: 'social', label: 'Social', href: '/c/1/social' },
  { id: 'review', label: 'Review', href: '/c/1/review', badge: '!' },
  { id: 'jobs', label: 'Background work', href: '/c/1/jobs' },
];

describe('splitTabs', () => {
  it('keeps everything in the row under the limit', () => {
    expect(splitTabs(TABS, 'article', 10).overflow).toEqual([]);
    expect(splitTabs(TABS, 'article', undefined).overflow).toEqual([]);
  });

  it('promotes the active tab into the row', () => {
    const { visible, overflow } = splitTabs(TABS, 'jobs', 4);
    expect(visible.map((tab) => tab.id)).toEqual([
      'article',
      'images',
      'videos',
      'jobs',
    ]);
    expect(overflow.map((tab) => tab.id)).toEqual(['social', 'review']);
  });
});

describe('Tabs with hrefs', () => {
  it('renders navigation links, not a tablist, with aria-current on the active tab', () => {
    render(Tabs, {
      props: { tabs: TABS, active: 'images', 'aria-label': 'Content sections' },
    });
    const nav = screen.getByRole('navigation', { name: 'Content sections' });
    expect(nav).toHaveAttribute('data-shell-tabs');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const active = within(nav).getByRole('link', { name: /Images/ });
    expect(active).toHaveAttribute('href', '/c/1/images');
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveTextContent('3');
    expect(
      within(nav).getByRole('link', { name: 'Article' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('moves extra tabs under "More", keeps the active one visible, and dots the menu for a hidden badge', async () => {
    const { container } = render(Tabs, {
      props: {
        tabs: TABS,
        active: 'jobs',
        maxVisible: 4,
        'aria-label': 'Content sections',
      },
    });
    const row = container.querySelector('.tabs-links-row') as HTMLElement;
    expect(
      within(row)
        .getAllByRole('link')
        .map((link) => link.dataset.tabId),
    ).toEqual(['article', 'images', 'videos', 'jobs']);
    const more = container.querySelector(
      'details.tabs-more',
    ) as HTMLDetailsElement;
    expect(within(more).getByText('More')).toBeInTheDocument();
    expect(within(more).getByText('(has updates)')).toBeInTheDocument();
    await userEvent.click(within(more).getByText('More'));
    expect(more.open).toBe(true);
    expect(within(more).getByRole('link', { name: /Review/ })).toHaveAttribute(
      'href',
      '/c/1/review',
    );
  });

  it('a disabled link tab never fires onchange', async () => {
    const onchange = vi.fn();
    render(Tabs, {
      props: {
        tabs: [
          { id: 'article', label: 'Article', href: '/c/1' },
          {
            id: 'locked',
            label: 'Locked',
            href: '/c/1/locked',
            disabled: true,
          },
        ],
        active: 'article',
        onchange,
        'aria-label': 'Content sections',
      },
    });
    const locked = screen.getByText('Locked').closest('a') as HTMLElement;
    await userEvent.click(locked);
    expect(onchange).not.toHaveBeenCalled();
  });

  it('does not dot "More" for an empty-string badge, matching the tab itself', () => {
    const { container } = render(Tabs, {
      props: {
        tabs: [
          { id: 'a', label: 'A', href: '/a' },
          { id: 'b', label: 'B', href: '/b' },
          { id: 'c', label: 'C', href: '/c', badge: '' },
        ],
        active: 'a',
        maxVisible: 2,
        'aria-label': 'Sections',
      },
    });
    const more = container.querySelector('details.tabs-more') as HTMLElement;
    expect(more).not.toBeNull();
    expect(more.querySelector('.tab-dot')).toBeNull();
    expect(more.querySelector('.tab-badge')).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(Tabs, {
      props: {
        tabs: TABS,
        active: 'article',
        maxVisible: 4,
        'aria-label': 'Content sections',
      },
    });
    await expectNoA11yViolations(container);
  });
});
