// @vitest-environment jsdom
/**
 * First component test in smrt-chat via the shared S11 harness (#1416). Avatar is
 * the thin adapter over the library Avatar (maps avatarUrl→src, dnd→busy).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import Avatar from '../Avatar.svelte';

describe('Avatar', () => {
  it('renders the initials derived from the name', () => {
    render(Avatar, { props: { name: 'Ada Lovelace' } });
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(Avatar, {
      props: { name: 'Ada Lovelace', onlineStatus: 'online' },
    });
    await expectNoA11yViolations(container);
  });
});
