/**
 * Component test for FilterChips (Sweep S11, #1416).
 *
 * FilterChips is a single-select filter: a `role="radiogroup"` of
 * `role="radio"` buttons where the selected option carries `aria-checked`.
 * (There is no per-chip remove/dismiss affordance in the source — selection is
 * the only interaction.) This suite asserts that structure/state, drives
 * selection via click, and proves axe-cleanliness, including the optional
 * "All" option.
 */
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import FilterChips from '../FilterChips.svelte';
import type { FilterOption } from '../types.js';

const OPTIONS: FilterOption[] = [
  { value: 'all-news', label: 'News', count: 12 },
  { value: 'sports', label: 'Sports', count: 5 },
  { value: 'tech', label: 'Tech' },
];

describe('FilterChips', () => {
  it('renders a radiogroup with one radio per option', () => {
    render(FilterChips, { props: { options: OPTIONS, selected: 'all-news' } });
    const group = screen.getByRole('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
  });

  it('marks the selected option with aria-checked=true and others false', () => {
    render(FilterChips, { props: { options: OPTIONS, selected: 'sports' } });
    expect(screen.getByRole('radio', { name: /Sports/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /News/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('renders the optional count alongside its chip label', () => {
    render(FilterChips, { props: { options: OPTIONS, selected: 'all-news' } });
    expect(screen.getByRole('radio', { name: /News/ })).toHaveTextContent('12');
  });

  it('fires onchange with the clicked option value', async () => {
    const onchange = vi.fn();
    render(FilterChips, {
      props: { options: OPTIONS, selected: 'all-news', onchange },
    });
    await userEvent.click(screen.getByRole('radio', { name: /Tech/ }));
    expect(onchange).toHaveBeenCalledWith('tech');
  });

  it('does not fire onchange when the already-selected chip is clicked', async () => {
    const onchange = vi.fn();
    render(FilterChips, {
      props: { options: OPTIONS, selected: 'sports', onchange },
    });
    await userEvent.click(screen.getByRole('radio', { name: /Sports/ }));
    expect(onchange).not.toHaveBeenCalled();
  });

  it('does not fire onchange for a disabled option', async () => {
    const onchange = vi.fn();
    const options: FilterOption[] = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
    ];
    render(FilterChips, { props: { options, selected: 'a', onchange } });
    const disabled = screen.getByRole('radio', { name: 'B' });
    expect(disabled).toBeDisabled();
    await userEvent.click(disabled);
    expect(onchange).not.toHaveBeenCalled();
  });

  it('prepends an "All" option (empty value) when showAll is set', async () => {
    const onchange = vi.fn();
    render(FilterChips, {
      props: {
        options: OPTIONS,
        selected: 'sports',
        showAll: true,
        allLabel: 'Everything',
        onchange,
      },
    });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    const all = screen.getByRole('radio', { name: /Everything/ });
    expect(all).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(all);
    expect(onchange).toHaveBeenCalledWith('');
  });

  it('is axe-clean for a default selected group', async () => {
    const { container } = render(FilterChips, {
      props: { options: OPTIONS, selected: 'all-news' },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean with the "All" option enabled', async () => {
    const { container } = render(FilterChips, {
      props: { options: OPTIONS, selected: '', showAll: true },
    });
    await expectNoA11yViolations(container);
  });
});
