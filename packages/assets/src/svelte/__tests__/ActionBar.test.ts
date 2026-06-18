// @vitest-environment jsdom
/**
 * First component test in a domain package via the shared S11 harness (#1416):
 * the whole Testing-Library + axe surface comes from `@happyvertical/smrt-vitest`
 * (no per-package testing-library deps), and the jsdom `<dialog>` polyfill +
 * jest-dom matchers come from the shared `svelte-setup` in vitest.config.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ActionBar from '../ActionBar.svelte';

// ActionBar only reads `selectedAssets.length` and forwards the array to its
// callbacks, so minimal id-only stubs are enough to drive it.
const selected = [{ id: '1' }, { id: '2' }] as any[];

describe('ActionBar', () => {
  it('shows the selected count and clears the selection', async () => {
    const onClearSelection = vi.fn();
    render(ActionBar, {
      props: { selectedAssets: selected, onClearSelection, onDelete: vi.fn() },
    });

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no assets are selected', () => {
    const { container } = render(ActionBar, {
      props: {
        selectedAssets: [],
        onClearSelection: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    expect(container.querySelector('.action-bar')).toBeNull();
  });

  it('confirms deletion through the inline dialog', async () => {
    const onDelete = vi.fn();
    render(ActionBar, {
      props: { selectedAssets: selected, onClearSelection: vi.fn(), onDelete },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // The library ConfirmDialog (S10) labels its dialog by the title heading.
    // Asserting the interpolated title AND message proves Svelte attribute-string
    // interpolation (`"… {count} …"`) resolves for component props (count = 2).
    const dialog = screen.getByRole('dialog', { name: /Delete 2 assets\?/ });
    expect(
      within(dialog).getByText(/This action cannot be undone\./),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' }),
    );
    expect(onDelete).toHaveBeenCalledWith(selected);
  });

  it('cancels deletion and dismisses the dialog', async () => {
    render(ActionBar, {
      props: {
        selectedAssets: selected,
        onClearSelection: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ActionBar, {
      props: {
        selectedAssets: selected,
        onClearSelection: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
