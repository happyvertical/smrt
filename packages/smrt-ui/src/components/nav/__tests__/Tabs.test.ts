/**
 * Component test for Tabs (Sweep S11, #1416).
 *
 * Tabs renders an ARIA tablist of `role="tab"` buttons with roving tabindex,
 * `aria-selected` on the active tab, and a `role="tabpanel"` for children.
 * This suite asserts that structure/state, drives click + Arrow/Home/End
 * keyboard navigation (which fire `onchange`), and proves axe-cleanliness.
 */
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Tabs from '../Tabs.svelte';
import type { Tab } from '../types.js';

const TABS: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity', count: 4 },
  { id: 'settings', label: 'Settings' },
];

/** Build a text Snippet for the Tabs `children` (panel) prop. */
function panelSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Tabs', () => {
  it('renders a tablist with one tab button per tab', () => {
    render(Tabs, {
      props: { tabs: TABS, active: 'overview', 'aria-label': 'Sections' },
    });
    const tablist = screen.getByRole('tablist', { name: 'Sections' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
  });

  it('marks the active tab with aria-selected and a tabindex of 0', () => {
    render(Tabs, { props: { tabs: TABS, active: 'activity' } });
    const active = screen.getByRole('tab', { name: /Activity/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active).toHaveAttribute('tabindex', '0');

    const inactive = screen.getByRole('tab', { name: 'Overview' });
    expect(inactive).toHaveAttribute('aria-selected', 'false');
    expect(inactive).toHaveAttribute('tabindex', '-1');
  });

  it('renders the optional count alongside its tab label', () => {
    render(Tabs, { props: { tabs: TABS, active: 'overview' } });
    expect(screen.getByRole('tab', { name: /Activity/ })).toHaveTextContent(
      '4',
    );
  });

  it('renders children inside a tabpanel labelled by the active tab', () => {
    render(Tabs, {
      props: {
        tabs: TABS,
        active: 'overview',
        children: panelSnippet('Overview content'),
      },
    });
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Overview content')).toBeInTheDocument();
  });

  it('fires onchange with the clicked tab id', async () => {
    const onchange = vi.fn();
    render(Tabs, { props: { tabs: TABS, active: 'overview', onchange } });
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(onchange).toHaveBeenCalledWith('settings');
  });

  it('does not fire onchange when the already-active tab is clicked', async () => {
    const onchange = vi.fn();
    render(Tabs, { props: { tabs: TABS, active: 'overview', onchange } });
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(onchange).not.toHaveBeenCalled();
  });

  // ArrowRight/ArrowLeft are asserted in separate renders rather than chained:
  // the component moves focus to the newly-activated tab, so a second arrow key
  // in the same render would target whichever tab focus landed on — racy across
  // suite ordering. Each test focuses one known tab and asserts a single hop.
  it('moves to the next tab with ArrowRight', async () => {
    const onchange = vi.fn();
    render(Tabs, { props: { tabs: TABS, active: 'overview', onchange } });
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onchange).toHaveBeenLastCalledWith('activity');
  });

  it('moves to the previous tab with ArrowLeft', async () => {
    const onchange = vi.fn();
    // Render with Activity active so it owns the roving tabindex and is focusable.
    // Activity carries a count badge, so its accessible name is "Activity 4".
    render(Tabs, { props: { tabs: TABS, active: 'activity', onchange } });
    screen.getByRole('tab', { name: /Activity/ }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onchange).toHaveBeenLastCalledWith('overview');
  });

  it('wraps from the first tab to the last with ArrowLeft', async () => {
    const onchange = vi.fn();
    render(Tabs, { props: { tabs: TABS, active: 'overview', onchange } });
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onchange).toHaveBeenLastCalledWith('settings');
  });

  it('jumps to the first/last tab with Home/End', async () => {
    const onchange = vi.fn();
    render(Tabs, { props: { tabs: TABS, active: 'activity', onchange } });
    screen.getByRole('tab', { name: /Activity/ }).focus();
    await userEvent.keyboard('{End}');
    expect(onchange).toHaveBeenLastCalledWith('settings');
    await userEvent.keyboard('{Home}');
    expect(onchange).toHaveBeenLastCalledWith('overview');
  });

  it('skips disabled tabs during keyboard navigation', async () => {
    const onchange = vi.fn();
    const tabs: Tab[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', disabled: true },
      { id: 'c', label: 'C' },
    ];
    render(Tabs, { props: { tabs, active: 'a', onchange } });
    expect(screen.getByRole('tab', { name: 'B' })).toBeDisabled();
    screen.getByRole('tab', { name: 'A' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onchange).toHaveBeenLastCalledWith('c');
  });

  it('is axe-clean with a labelled tablist and panel', async () => {
    const { container } = render(Tabs, {
      props: {
        tabs: TABS,
        active: 'overview',
        'aria-label': 'Sections',
        children: panelSnippet('Panel content'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
