// @vitest-environment jsdom
/**
 * Component coverage for UserForm via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import UserForm from '../UserForm.svelte';

describe('UserForm', () => {
  it('renders create-mode fields and a Create button', () => {
    render(UserForm, { props: { onsubmit: vi.fn() } });
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create User' }),
    ).toBeInTheDocument();
  });

  it('submits the entered name and email', async () => {
    const onsubmit = vi.fn();
    render(UserForm, { props: { onsubmit } });
    await userEvent.type(screen.getByLabelText('Name'), 'Ada Lovelace');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create User' }));
    expect(onsubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      }),
    );
  });

  it('locks the email and switches to update mode for an existing user', () => {
    render(UserForm, {
      props: {
        onsubmit: vi.fn(),
        user: { email: 'ada@example.com', status: 'active' } as any,
        profile: { name: 'Ada Lovelace' } as any,
      },
    });
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Update User' }),
    ).toBeInTheDocument();
  });

  it('invokes oncancel from the Cancel button', async () => {
    const oncancel = vi.fn();
    render(UserForm, { props: { onsubmit: vi.fn(), oncancel } });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean', async () => {
    const { container } = render(UserForm, {
      props: { onsubmit: vi.fn(), oncancel: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
