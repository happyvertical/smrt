// The hosted app's signed-out landing (#5191): a visitor with no session is
// offered the operator's identity provider, never the desktop's owner setup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oidc = vi.hoisted(() => ({
  config: {} as {
    defaultProvider?: string;
    providers?: Record<string, unknown>;
  },
}));
vi.mock('@happyvertical/smrt-users', async (importActual) => ({
  ...(await importActual<typeof import('@happyvertical/smrt-users')>()),
  getUsersOidcConfig: () => oidc.config,
}));

import { load } from '../../routes/+page.server.ts';
import { cloudSignInHref, signInHrefFor } from './cloud-auth.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { configureShell, resetShell } from './host.ts';

const signedOut = { authenticated: false };
const visit = (search = '', session: object = signedOut) =>
  load({
    parent: async () => ({ description: null, session }),
    depends: () => {},
    fetch: (() => {
      throw new Error('no fetch for a signed-out visitor');
    }) as never,
    url: new URL(`https://app.example.test/${search}`),
  } as never) as Promise<Record<string, unknown>>;

describe('which provider a signed-out visitor is sent to', () => {
  it('is the default provider, or the only one, encoded in the path', () => {
    expect(
      signInHrefFor({
        defaultProvider: 'acme',
        providers: { acme: {}, b: {} },
      }),
    ).toBe('/auth/acme/login');
    expect(signInHrefFor({ providers: { 'one two': {} } })).toBe(
      '/auth/one%20two/login',
    );
  });
  it('is nothing when none, or no single one, is configured', () => {
    expect(signInHrefFor({})).toBeNull();
    expect(signInHrefFor({ providers: { a: {}, b: {} } })).toBeNull();
    // A default that names no configured provider is not trusted.
    expect(
      signInHrefFor({ defaultProvider: 'ghost', providers: { a: {}, b: {} } }),
    ).toBeNull();
  });
});

describe('cloud landing', () => {
  let h: CloudHarness;
  beforeEach(async () => {
    h = await openCloudShell();
    oidc.config = { defaultProvider: 'acme', providers: { acme: {} } };
  });
  afterEach(async () => {
    await h.close();
  });

  it('offers sign-in, and says when a sign-in failed', async () => {
    expect(await cloudSignInHref()).toBe('/auth/acme/login');
    expect(await visit()).toMatchObject({
      hosted: true,
      signIn: '/auth/acme/login',
      signInFailed: false,
    });
    expect(await visit('?signin=failed')).toMatchObject({ signInFailed: true });
  });

  it('says so when no provider is configured (never a /setup link)', async () => {
    oidc.config = {};
    expect(await visit()).toMatchObject({ hosted: true, signIn: null });
  });

  it('does nothing for a signed-in visitor', async () => {
    expect(await visit('', { authenticated: true })).toMatchObject({
      hosted: false,
      signIn: null,
      signInFailed: false,
    });
  });
});

describe('desktop landing is unchanged', () => {
  beforeEach(() => {
    oidc.config = { defaultProvider: 'acme', providers: { acme: {} } };
  });
  afterEach(async () => {
    await resetShell();
  });
  it('no sign-in link, not hosted (configured local, and not configured at all)', async () => {
    configureShell({
      db: async () => ({}) as never,
      dataRoot: async () => '/tmp',
    });
    expect(await cloudSignInHref()).toBeNull();
    expect(await visit('?signin=failed')).toMatchObject({
      hosted: false,
      signIn: null,
      signInFailed: false,
    });
    await resetShell();
    expect(await visit()).toMatchObject({ hosted: false, signIn: null });
  });
});
