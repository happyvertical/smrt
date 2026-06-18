// @vitest-environment jsdom
/**
 * Component coverage for UserCard via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import UserCard from '../UserCard.svelte';

const baseProps = (over = {}) => ({
  user: { id: 'u1', email: 'ada@example.com', status: 'active' } as any,
  profile: { name: 'Ada Lovelace' } as any,
  role: 'admin',
  status: 'active',
  ...over,
});

describe('UserCard', () => {
  it('renders the name, email, role, and status', () => {
    render(UserCard, { props: baseProps() });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('invokes onclick when the card is activated', async () => {
    const onclick = vi.fn();
    render(UserCard, { props: baseProps({ onclick }) });
    await userEvent.click(screen.getByRole('button'));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('is a disabled, non-interactive card without an onclick', () => {
    render(UserCard, { props: baseProps() });
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is axe-clean', async () => {
    const { container } = render(UserCard, {
      props: baseProps({ onclick: vi.fn() }),
    });
    await expectNoA11yViolations(container);
  });
});
