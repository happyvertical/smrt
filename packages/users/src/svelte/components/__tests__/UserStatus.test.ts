// @vitest-environment jsdom
/**
 * Regression coverage for the status-enum divergence (#1399, finding #4):
 * UserForm previously offered `deactivated` (not a UserStatus value) and
 * omitted `inactive`, and UserCard.statusClass had `case 'deactivated'` with no
 * `case 'inactive'` so real inactive users rendered unstyled.
 */
import type { Profile } from '@happyvertical/smrt-profiles';
import { UserStatus } from '@happyvertical/smrt-types';
import type { User } from '@happyvertical/smrt-users';
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import UserCard from '../UserCard.svelte';
import UserForm from '../UserForm.svelte';

const profile = { name: 'Ada Lovelace', email: 'ada@example.com' } as Profile;
const user = { email: 'ada@example.com', status: UserStatus.INACTIVE } as User;

describe('UserForm status options', () => {
  it('offers exactly the UserStatus values — including inactive, never deactivated', () => {
    render(UserForm, { props: { onsubmit: vi.fn() } });

    const select = screen.getByLabelText('Status', {
      hidden: true,
    }) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);

    expect(optionValues).toEqual(Object.values(UserStatus));
    expect(optionValues).toContain('inactive');
    expect(optionValues).not.toContain('deactivated');
  });
});

describe('UserCard status styling', () => {
  it('styles an inactive user instead of leaving it unstyled', () => {
    render(UserCard, {
      props: { user, profile, status: 'inactive' },
    });

    const badge = screen.getByText('inactive', { hidden: true });
    expect(badge.className).toContain('status-disabled');
  });

  it('does not recognise the bogus deactivated value', () => {
    render(UserCard, {
      props: { user, profile, status: 'deactivated' },
    });

    const badge = screen.getByText('deactivated', { hidden: true });
    // No status-* style class is applied for a non-enum value.
    expect(badge.className).not.toContain('status-disabled');
  });
});
