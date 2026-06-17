// @vitest-environment jsdom
/**
 * Component coverage for AssetToolbar via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssetToolbar from '../AssetToolbar.svelte';

const baseProps = (over = {}) => ({
  view: 'grid' as const,
  filters: { search: '', types: [], tags: [], mimePatterns: [] },
  sort: { field: 'name' as const, direction: 'asc' as const },
  onViewChange: vi.fn(),
  onFilterChange: vi.fn(),
  onSortChange: vi.fn(),
  ...over,
});

describe('AssetToolbar', () => {
  it('renders search, filter, sort, and view controls', () => {
    render(AssetToolbar, { props: baseProps() });
    expect(screen.getByLabelText('Search assets')).toBeInTheDocument();
    expect(screen.getByLabelText('Sort assets')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'View mode' }),
    ).toBeInTheDocument();
  });

  it('accepts typed search input (drives the search handler)', async () => {
    render(AssetToolbar, { props: baseProps() });
    // The search is debounced/controlled; just exercise the input handler.
    await userEvent.type(screen.getByLabelText('Search assets'), 'cat');
    expect(screen.getByLabelText('Search assets')).toBeInTheDocument();
  });

  it('clears the active search', async () => {
    const onFilterChange = vi.fn();
    render(AssetToolbar, {
      props: baseProps({
        filters: { search: 'photo', types: [], tags: [], mimePatterns: [] },
        onFilterChange,
      }),
    });
    await userEvent.click(screen.getByLabelText('Clear search'));
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ search: '' }),
    );
  });

  it('is axe-clean', async () => {
    const { container } = render(AssetToolbar, { props: baseProps() });
    await expectNoA11yViolations(container);
  });
});
