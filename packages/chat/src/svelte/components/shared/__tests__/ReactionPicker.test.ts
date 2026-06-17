// @vitest-environment jsdom
/**
 * Component coverage for ReactionPicker via the shared S11 harness (#1416).
 */
import {
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ReactionPicker from '../ReactionPicker.svelte';

// NOTE: axe is intentionally not asserted here. ReactionPicker uses `role="grid"`
// with buttons as direct children, which trips axe's `aria-required-children`
// (a grid must contain `role="row"` → gridcells). Pre-existing a11y bug to fix
// under S12 (#1417) — masking it with a passing axe test would hide it.

describe('ReactionPicker', () => {
  it('renders a grid of emoji buttons when open', () => {
    render(ReactionPicker, { props: { onreact: vi.fn(), isOpen: true } });
    const grid = screen.getByRole('grid', { name: 'Emoji reactions' });
    expect(within(grid).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('reports the chosen emoji through onreact', async () => {
    const onreact = vi.fn();
    render(ReactionPicker, { props: { onreact, isOpen: true } });
    const [first] = within(
      screen.getByRole('grid', { name: 'Emoji reactions' }),
    ).getAllByRole('button');
    await userEvent.click(first);
    expect(onreact).toHaveBeenCalledTimes(1);
    expect(onreact.mock.calls[0][0]).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    render(ReactionPicker, { props: { onreact: vi.fn(), isOpen: false } });
    expect(screen.queryByRole('grid')).toBeNull();
  });
});
