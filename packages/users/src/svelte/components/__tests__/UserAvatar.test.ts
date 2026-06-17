// @vitest-environment jsdom
/**
 * First component test in smrt-users via the shared S11 harness (#1416): the
 * Testing-Library + axe surface comes from `@happyvertical/smrt-vitest` and the
 * jsdom + jest-dom setup from the shared `svelte-setup` wired in vitest.config.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import UserAvatar from '../UserAvatar.svelte';

// UserAvatar only reads `profile.name`, so a minimal stub is enough to drive it.
const profile = { name: 'Ada Lovelace' } as any;

describe('UserAvatar', () => {
  it('renders the initials derived from the profile name', () => {
    render(UserAvatar, { props: { profile } });
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('renders the full name when showName is set', () => {
    render(UserAvatar, { props: { profile, showName: true } });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('falls back to "U" initials for a profile with no name', () => {
    render(UserAvatar, { props: { profile: {} as any } });
    expect(screen.getByText('U')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(UserAvatar, {
      props: { profile, showName: true },
    });
    await expectNoA11yViolations(container);
  });
});
