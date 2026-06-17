// @vitest-environment jsdom
/**
 * Component coverage for UserPresence via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import UserPresence from '../UserPresence.svelte';

describe('UserPresence', () => {
  it('exposes the status as an accessible label', () => {
    render(UserPresence, { props: { status: 'online' } });
    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('shows a visible label when requested', () => {
    render(UserPresence, { props: { status: 'dnd', showLabel: true } });
    expect(screen.getByText('Do not disturb')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(UserPresence, {
      props: { status: 'away', showLabel: true },
    });
    await expectNoA11yViolations(container);
  });
});
