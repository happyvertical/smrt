/**
 * Browser passkey helpers (#3275). The browser's own WebAuthn prompt is the
 * one thing stubbed (`@simplewebauthn/browser` needs a real authenticator
 * UI); the request choreography and error surface are the code under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));
vi.mock('@simplewebauthn/browser', () => browser);

import { createUsersAuthAdapter } from '../svelte/auth.js';
import {
  browserSupportsPasskeys,
  createPasskeySignInCeremony,
  PasskeyRequestError,
  registerPasskey,
} from '../svelte/passkey.js';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('passkey browser helpers', () => {
  beforeEach(() => {
    browser.startAuthentication.mockReset();
    browser.startRegistration.mockReset();
  });

  it('reports support from the browser library', () => {
    // Node has no window: no passkeys, whatever the library says.
    expect(browserSupportsPasskeys()).toBe(false);
  });

  it('runs a sign-in ceremony: options, prompt, post the assertion', async () => {
    browser.startAuthentication.mockResolvedValue({ id: 'cred' });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/options')
        ? reply({ ceremonyId: 'c1', options: { challenge: 'abc' } })
        : reply({ authenticated: true });
    }) as unknown as typeof fetch;

    await createPasskeySignInCeremony({ fetch: fetcher })();

    expect(calls.map((call) => call.url)).toEqual([
      '/auth/passkey/options',
      '/auth/passkey/sign-in',
    ]);
    expect(browser.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'abc' },
    });
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      ceremonyId: 'c1',
      response: { id: 'cred' },
    });
    expect(calls[1]?.init?.credentials).toBe('same-origin');
  });

  it('fits createUsersAuthAdapter({ passkeyCeremony })', async () => {
    browser.startAuthentication.mockResolvedValue({ id: 'cred' });
    const fetcher = (async (url: string) =>
      reply(
        url.endsWith('/options')
          ? { ceremonyId: 'c', options: {} }
          : { authenticated: true },
      )) as unknown as typeof fetch;
    const adapter = createUsersAuthAdapter({
      passkeyCeremony: createPasskeySignInCeremony({ fetch: fetcher }),
    });
    await expect(adapter.signInWithPasskey?.()).resolves.toBeUndefined();
  });

  it('throws a PasskeyRequestError carrying the server code on a refusal', async () => {
    browser.startAuthentication.mockResolvedValue({ id: 'cred' });
    const fetcher = (async (url: string) =>
      url.endsWith('/options')
        ? reply({ ceremonyId: 'c', options: {} })
        : reply(
            { error: 'Invalid credentials.', code: 'invalid_credentials' },
            401,
          )) as unknown as typeof fetch;
    const error = await createPasskeySignInCeremony({ fetch: fetcher })().catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(PasskeyRequestError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credentials' });
    // The message is generic: server detail is not surfaced by accident.
    expect(error.message).toBe('Authentication request was refused.');
  });

  it('stops before the prompt when options cannot be fetched, and lets a dismissed prompt through', async () => {
    const failing = (async () => reply({ code: 'rate_limited' }, 429)) as never;
    await expect(
      createPasskeySignInCeremony({ fetch: failing })(),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(browser.startAuthentication).not.toHaveBeenCalled();

    browser.startAuthentication.mockRejectedValue(
      Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }),
    );
    const posted: string[] = [];
    const fetcher = (async (url: string) => {
      posted.push(url);
      return reply({ ceremonyId: 'c', options: {} });
    }) as unknown as typeof fetch;
    await expect(
      createPasskeySignInCeremony({ fetch: fetcher })(),
    ).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(posted).toEqual(['/auth/passkey/options']);
  });

  it('registers a passkey and returns the server summary, honouring custom endpoints', async () => {
    browser.startRegistration.mockResolvedValue({ id: 'new' });
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return url.endsWith('/o')
        ? reply({ ceremonyId: 'r1', options: { challenge: 'x' } })
        : reply({ passkey: { id: 'p1', name: 'Phone' } });
    }) as unknown as typeof fetch;

    const passkey = await registerPasskey({
      name: 'Phone',
      optionsEndpoint: '/me/passkeys/o',
      registerEndpoint: '/me/passkeys',
      fetch: fetcher,
    });
    expect(passkey).toEqual({ id: 'p1', name: 'Phone' });
    expect(calls).toEqual([
      { url: '/me/passkeys/o', body: undefined },
      {
        url: '/me/passkeys',
        body: { ceremonyId: 'r1', response: { id: 'new' }, name: 'Phone' },
      },
    ]);
  });

  it("shows the server's own message for a registration refusal and the code for the rest", async () => {
    browser.startRegistration.mockResolvedValue({ id: 'new' });
    const refuse = (body: unknown, status: number) =>
      (async (url: string) =>
        url.endsWith('/options')
          ? reply({ ceremonyId: 'r', options: {} })
          : reply(body, status)) as unknown as typeof fetch;

    await expect(
      registerPasskey({
        fetch: refuse(
          {
            error: 'You can register at most 10 passkeys.',
            code: 'passkey_registration',
          },
          400,
        ),
      }),
    ).rejects.toMatchObject({
      code: 'passkey_registration',
      message: 'You can register at most 10 passkeys.',
    });
    await expect(
      registerPasskey({
        fetch: refuse({ error: 'x', code: 'reauthentication_required' }, 401),
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'reauthentication_required',
      message: 'Authentication request was refused.',
    });
  });
});
