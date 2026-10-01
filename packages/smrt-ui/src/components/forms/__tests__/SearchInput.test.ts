import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import SearchInput from '../SearchInput.svelte';

describe('SearchInput', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('is a labelled search field in a search landmark', () => {
    render(SearchInput, {
      props: { value: '', onsearch: vi.fn(), placeholder: 'Search by title' },
    });
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveAttribute(
      'placeholder',
      'Search by title',
    );
  });

  it('searches once, trimmed and single-line, after the last key', async () => {
    const onsearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(SearchInput, { props: { value: '', onsearch, debounceMs: 300 } });
    await user.type(screen.getByRole('searchbox'), '  council   hall ');
    expect(onsearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onsearch).toHaveBeenCalledTimes(1);
    expect(onsearch).toHaveBeenCalledWith('council hall');
  });

  it('searches at once on Enter', async () => {
    const onsearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(SearchInput, { props: { value: '', onsearch } });
    await user.type(screen.getByRole('searchbox'), 'roads{Enter}');
    expect(onsearch).toHaveBeenCalledWith('roads');
  });

  it('does not search for the search it is already showing', async () => {
    const onsearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(SearchInput, { props: { value: 'roads', onsearch } });
    await user.type(screen.getByRole('searchbox'), '{Enter}');
    expect(onsearch).not.toHaveBeenCalled();
  });

  it('clears with the x and focuses the field', async () => {
    const onsearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(SearchInput, { props: { value: 'roads', onsearch } });
    const field = screen.getByRole('searchbox');
    expect(field).toHaveValue('roads');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onsearch).toHaveBeenCalledWith('');
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('follows the applied search when it changes from outside', async () => {
    const { rerender } = render(SearchInput, {
      props: { value: 'roads', onsearch: vi.fn() },
    });
    await rerender({ value: 'parks', onsearch: vi.fn() });
    expect(screen.getByRole('searchbox')).toHaveValue('parks');
  });

  it('is axe-clean', async () => {
    const { container } = render(SearchInput, {
      props: { value: 'roads', onsearch: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
