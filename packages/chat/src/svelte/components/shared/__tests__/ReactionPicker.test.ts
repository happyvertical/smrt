// @vitest-environment jsdom
/**
 * Component coverage for ReactionPicker via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ReactionPicker from '../ReactionPicker.svelte';

// S12 a11y remediation (#1417): the picker is now a labelled `role="group"` of
// buttons (was an invalid `role="grid"` with button children, which tripped axe's
// `aria-required-children`), so axe is asserted on the open state.

describe('ReactionPicker', () => {
  it('renders a labelled group of emoji buttons when open', () => {
    render(ReactionPicker, { props: { onreact: vi.fn(), isOpen: true } });
    const group = screen.getByRole('group', { name: 'Emoji reactions' });
    expect(within(group).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('reports the chosen emoji through onreact', async () => {
    const onreact = vi.fn();
    render(ReactionPicker, { props: { onreact, isOpen: true } });
    const [first] = within(
      screen.getByRole('group', { name: 'Emoji reactions' }),
    ).getAllByRole('button');
    await userEvent.click(first);
    expect(onreact).toHaveBeenCalledTimes(1);
    expect(onreact.mock.calls[0][0]).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    render(ReactionPicker, { props: { onreact: vi.fn(), isOpen: false } });
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(ReactionPicker, {
      props: { onreact: vi.fn(), isOpen: true },
    });
    await expectNoA11yViolations(container);
  });
});
