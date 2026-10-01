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

  it('inside a host form, Enter searches and never submits the host form', async () => {
    const onsearch = vi.fn();
    const onsubmit = vi.fn((event: Event) => event.preventDefault());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const host = document.createElement('form');
    host.addEventListener('submit', onsubmit);
    document.body.append(host);
    render(SearchInput, { target: host, props: { value: '', onsearch } });
    expect(host.querySelector('form')).toBeNull();
    await user.type(screen.getByRole('searchbox'), 'roads{Enter}');
    expect(onsearch).toHaveBeenCalledWith('roads');
    expect(onsubmit).not.toHaveBeenCalled();
    host.remove();
  });

  it('a value the host normalized differently does not swallow a later one', async () => {
    const onsearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(SearchInput, { props: { value: '', onsearch } });
    await user.type(screen.getByRole('searchbox'), 'Roads{Enter}');
    expect(onsearch).toHaveBeenCalledWith('Roads');
    // The host applies its own normalization, then later navigates to the
    // exact text the box once sent: the box must follow both.
    await view.rerender({ value: 'roads', onsearch });
    expect(screen.getByRole('searchbox')).toHaveValue('roads');
    await view.rerender({ value: 'Roads', onsearch });
    expect(screen.getByRole('searchbox')).toHaveValue('Roads');
  });

  it('is axe-clean', async () => {
    const { container } = render(SearchInput, {
      props: { value: 'roads', onsearch: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
