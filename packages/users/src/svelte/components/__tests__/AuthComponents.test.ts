// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AccountSecurityPanel from '../AccountSecurityPanel.svelte';
import MagicLinkForm from '../MagicLinkForm.svelte';
import OidcProviderButtons from '../OidcProviderButtons.svelte';
import PasskeySignInButton from '../PasskeySignInButton.svelte';
import SignInForm from '../SignInForm.svelte';
import SignUpForm from '../SignUpForm.svelte';

describe('authentication components', () => {
  it('submits password credentials through the host boundary', async () => {
    const signInWithPassword = vi.fn().mockResolvedValue(undefined);
    render(SignInForm, { props: { adapter: { signInWithPassword } } });
    await userEvent.type(
      screen.getByLabelText('Email address'),
      'ada@example.com',
    );
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'secret',
    });
  });

  it('does not send mismatched sign-up passwords', async () => {
    const signUp = vi.fn();
    render(SignUpForm, { props: { adapter: { signUp } } });
    const fields = screen.getAllByLabelText(/password/i);
    await userEvent.type(
      screen.getByLabelText('Email address'),
      'ada@example.com',
    );
    await userEvent.type(fields[0], 'one');
    await userEvent.type(fields[1], 'two');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Passwords do not match.',
    );
    expect(signUp).not.toHaveBeenCalled();
  });

  it('requests and confirms opaque magic-link values through the host boundary', async () => {
    const requestMagicLink = vi.fn().mockResolvedValue(undefined);
    render(MagicLinkForm, { props: { adapter: { requestMagicLink } } });
    await userEvent.type(
      screen.getByLabelText('Email address'),
      'ada@example.com',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Send sign-in link' }),
    );
    expect(requestMagicLink).toHaveBeenCalledWith({ email: 'ada@example.com' });
    const confirmMagicLink = vi.fn().mockResolvedValue(undefined);
    render(MagicLinkForm, {
      props: { adapter: { confirmMagicLink }, token: 'opaque-token' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm sign in' }),
    );
    expect(confirmMagicLink).toHaveBeenCalledWith({ token: 'opaque-token' });
  });

  it('uses only configured OIDC and passkey capabilities', async () => {
    const signInWithOidc = vi.fn().mockResolvedValue(undefined);
    const signInWithPasskey = vi.fn().mockResolvedValue(undefined);
    render(OidcProviderButtons, {
      props: {
        adapter: { signInWithOidc },
        providers: [{ id: 'work', label: 'Work SSO' }],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Work SSO' }));
    expect(signInWithOidc).toHaveBeenCalledWith({ providerId: 'work' });
    render(PasskeySignInButton, { props: { adapter: {} } });
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull();
    render(PasskeySignInButton, { props: { adapter: { signInWithPasskey } } });
    await userEvent.click(screen.getByRole('button', { name: /passkey/i }));
    expect(signInWithPasskey).toHaveBeenCalledOnce();
  });

  it('renders session and API-key metadata without secrets and revokes selected rows', async () => {
    const revokeSession = vi.fn().mockResolvedValue(undefined);
    const revokeApiKey = vi.fn().mockResolvedValue(undefined);
    render(AccountSecurityPanel, {
      props: {
        adapter: { revokeSession, revokeApiKey },
        sessions: [{ id: 's1', label: 'Laptop' }],
        apiKeys: [{ id: 'k1', label: 'Automation' }],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeSession).toHaveBeenCalledWith('s1');
    expect(revokeApiKey).toHaveBeenCalledWith('k1');
    expect(screen.queryByText(/secret/i)).toBeNull();
  });
});
