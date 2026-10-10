// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import { createUsersAuthAdapter, type UsersAuthAdapter } from '../../auth.js';
import AuthI18nHarness from './AuthI18nHarness.svelte';

const diagnostic =
  'PRIVATE adapter diagnostic: internal credential storage unavailable';
const scenarios = [
  {
    method: 'signInWithPassword',
    view: 'sign-in',
    button: 'Se connecter',
    french: 'Impossible de se connecter.',
    english: 'Unable to sign in.',
  },
  {
    method: 'signUp',
    view: 'sign-up',
    button: 'Créer un compte',
    french: 'Impossible de créer le compte.',
    english: 'Unable to create account.',
  },
  {
    method: 'requestMagicLink',
    view: 'magic-link',
    button: 'Envoyer le lien',
    french: 'Impossible de continuer avec le lien.',
    english: 'Unable to continue with the sign-in link.',
  },
  {
    method: 'confirmMagicLink',
    view: 'magic-link',
    token: 'opaque-token',
    button: 'Confirmer la connexion',
    french: 'Impossible de continuer avec le lien.',
    english: 'Unable to continue with the sign-in link.',
  },
  {
    method: 'signInWithOidc',
    view: 'oidc',
    button: 'Work SSO',
    french: 'Impossible de démarrer la connexion unique.',
    english: 'Unable to start single sign-on.',
  },
  {
    method: 'signInWithPasskey',
    view: 'passkey',
    button: 'Utiliser une clé d’accès',
    french: 'La connexion avec la clé d’accès a échoué.',
    english: 'Passkey sign-in was not completed.',
  },
  {
    method: 'revokeSession',
    view: 'security',
    button: 'Se déconnecter',
    french: 'Impossible de révoquer la session.',
    english: 'Unable to revoke session.',
  },
  {
    method: 'revokeApiKey',
    view: 'security',
    button: 'Révoquer',
    french: 'Impossible de révoquer la clé API.',
    english: 'Unable to revoke API key.',
  },
] as const;

async function fillDraft(confirm = 'secret') {
  const email = screen.queryByLabelText('Adresse e-mail');
  if (email) await userEvent.type(email, 'ada@example.com');
  const password = screen.queryByLabelText('Mot de passe');
  if (password) await userEvent.type(password, 'secret');
  const confirmation = screen.queryByLabelText('Confirmer le mot de passe');
  if (confirmation) await userEvent.type(confirmation, confirm);
  return [email, password, confirmation].filter(
    (input): input is HTMLInputElement => input instanceof HTMLInputElement,
  );
}

async function switchAndCheckFeedback(
  role: 'alert' | 'status',
  english: string,
  french: string,
  draft: HTMLInputElement[],
) {
  const values = draft.map((input) => input.value);
  await userEvent.click(screen.getByRole('button', { name: 'Switch locale' }));
  expect(screen.getByRole(role)).toHaveTextContent(english);
  for (const [index, input] of draft.entries()) {
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(values[index]);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Switch locale' }));
  expect(screen.getByRole(role)).toHaveTextContent(french);
}

describe.each([
  'host callback',
  'shipped adapter',
] as const)('safe reactive auth feedback: %s', (boundary) => {
  it.each(
    scenarios,
  )('localizes $method failures without exposing diagnostics or repeating requests', async (scenario) => {
    const callback = vi.fn().mockRejectedValue(new Error(diagnostic));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    const adapter: UsersAuthAdapter =
      boundary === 'host callback'
        ? { [scenario.method]: callback }
        : createUsersAuthAdapter({ fetch: request, passkeyCeremony: callback });
    const action =
      boundary === 'host callback' || scenario.method === 'signInWithPasskey'
        ? callback
        : request;
    render(AuthI18nHarness, {
      props: {
        view: scenario.view,
        adapter,
        token: 'token' in scenario ? scenario.token : undefined,
      },
    });
    const draft = await fillDraft();
    await userEvent.click(
      screen.getByRole('button', { name: scenario.button }),
    );
    expect(action).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent(diagnostic);
    expect(document.body).not.toHaveTextContent(
      'Authentication request was refused.',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(scenario.french);
    await switchAndCheckFeedback(
      'alert',
      scenario.english,
      scenario.french,
      draft,
    );
    expect(action).toHaveBeenCalledOnce();
  });
});

it('translates an existing sign-up mismatch while preserving all drafts without calling the adapter', async () => {
  const signUp = vi.fn();
  render(AuthI18nHarness, { props: { view: 'sign-up', adapter: { signUp } } });
  const draft = await fillDraft('different');
  await userEvent.click(
    screen.getByRole('button', { name: 'Créer un compte' }),
  );
  const french = 'Les mots de passe ne correspondent pas.';
  expect(screen.getByRole('alert')).toHaveTextContent(french);
  await switchAndCheckFeedback(
    'alert',
    'Passwords do not match.',
    french,
    draft,
  );
  expect(signUp).not.toHaveBeenCalled();
});

it.each([
  {
    method: 'requestMagicLink',
    token: undefined,
    button: 'Envoyer le lien',
    french: 'Consultez votre messagerie pour le lien de connexion.',
    english: 'Check your email for a sign-in link.',
    input: { email: 'ada@example.com' },
  },
  {
    method: 'confirmMagicLink',
    token: 'opaque-token',
    button: 'Confirmer la connexion',
    french: 'Votre lien de connexion a été confirmé.',
    english: 'Your sign-in link was confirmed.',
    input: { token: 'opaque-token' },
  },
] as const)('translates existing $method success without repeating the request', async (scenario) => {
  const callback = vi.fn().mockResolvedValue(undefined);
  render(AuthI18nHarness, {
    props: {
      view: 'magic-link',
      adapter: { [scenario.method]: callback },
      token: scenario.token,
    },
  });
  const draft = await fillDraft();
  await userEvent.click(screen.getByRole('button', { name: scenario.button }));
  expect(callback).toHaveBeenCalledExactlyOnceWith(scenario.input);
  expect(screen.getByRole('status')).toHaveTextContent(scenario.french);
  await switchAndCheckFeedback(
    'status',
    scenario.english,
    scenario.french,
    draft,
  );
  expect(callback).toHaveBeenCalledOnce();
});
