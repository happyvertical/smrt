// @vitest-environment jsdom
/**
 * Component coverage for UserList via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import UserList from '../UserList.svelte';

const users = [
  {
    user: { id: 'u1', email: 'ada@example.com', status: 'active' } as any,
    profile: { name: 'Ada Lovelace' } as any,
    role: 'admin',
  },
  {
    user: { id: 'u2', email: 'alan@example.com', status: 'pending' } as any,
    profile: { name: 'Alan Turing' } as any,
    role: 'member',
  },
];

describe('UserList', () => {
  it('renders a card per user', () => {
    render(UserList, { props: { users } });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
  });

  it('forwards the selected user through onselect', async () => {
    const onselect = vi.fn();
    render(UserList, { props: { users, onselect } });
    await userEvent.click(screen.getByText('Alan Turing'));
    expect(onselect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u2' }),
    );
  });

  it('shows the empty message when there are no users', () => {
    render(UserList, {
      props: { users: [], emptyMessage: 'Nobody here' },
    });
    expect(screen.getByText('Nobody here')).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    render(UserList, { props: { users: [], loading: true } });
    expect(screen.getByText('Loading users...')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(UserList, {
      props: { users, onselect: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
