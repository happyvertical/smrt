import { clearCache } from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcLoginError } from '../services/OidcLoginService.js';
import {
  beginOidcLogin,
  getOidcClientRegistration,
} from '../sveltekit/index.js';

// #3569: Kanidm drops a pending authorization whenever the user detours
// through its own /ui/login page and then lands the user in its apps panel.
// The client's landing URL is the only way back, so SMRT publishes the URL to
// register there from the same options the route handlers use.

const kanidm = {
  clientId: 'work-happyvertical',
  clientSecret: 'secret',
  issuer: 'https://idp.example.com/oauth2/openid/work-happyvertical',
  kind: 'kanidm' as const,
};

function cookieStub() {
  const jar = new Map<string, string>();
  return {
    delete: (name: string) => {
      jar.delete(name);
    },
    get: (name: string) => jar.get(name),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  };
}

describe('getOidcClientRegistration', () => {
  afterEach(() => {
    clearCache();
  });

  it('derives the callback and login-start URLs from the default route layout', () => {
    expect(
      getOidcClientRegistration('https://app.example.com/some/page?x=1', {
        provider: 'happyvertical',
        providers: { happyvertical: kanidm },
      }),
    ).toEqual({
      landingUrl: 'https://app.example.com/auth/happyvertical/login',
      providerName: 'happyvertical',
      redirectUri: 'https://app.example.com/auth/happyvertical/callback',
    });
  });

  it('honours custom callbackPath/loginPath, the default provider, and an explicit redirectUri', () => {
    const registration = getOidcClientRegistration(
      new URL('https://app.example.com'),
      {
        callbackPath: (name) => `/sso/${name}/return`,
        defaultProvider: 'kanidm',
        loginPath: (name) => `/sso/${name}/start`,
        providers: { kanidm },
      },
    );
    expect(registration).toEqual({
      landingUrl: 'https://app.example.com/sso/kanidm/start',
      providerName: 'kanidm',
      redirectUri: 'https://app.example.com/sso/kanidm/return',
    });

    expect(
      getOidcClientRegistration('https://app.example.com', {
        loginPath: '/signin/idp',
        provider: 'kanidm',
        providers: {
          kanidm: {
            ...kanidm,
            redirectUri: 'https://login.example.com/cb',
          },
        },
      }),
    ).toMatchObject({
      landingUrl: 'https://app.example.com/signin/idp',
      redirectUri: 'https://login.example.com/cb',
    });
  });

  it('fails closed for an unknown provider', () => {
    expect(() =>
      getOidcClientRegistration('https://app.example.com', {
        provider: 'missing',
        providers: { kanidm },
      }),
    ).toThrow(OidcLoginError);
  });

  it('registers exactly the redirect_uri the login handler sends, and the landing URL re-enters that handler', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://idp.example.com/ui/oauth2',
            issuer: kanidm.issuer,
            jwks_uri: 'https://idp.example.com/jwks',
            token_endpoint: 'https://idp.example.com/oauth2/token',
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
    );
    const options = {
      db: { type: 'sqlite' as const, url: ':memory:' },
      fetch: fetchMock,
      providers: { happyvertical: kanidm },
    };
    const registration = getOidcClientRegistration('https://app.example.com', {
      ...options,
      provider: 'happyvertical',
    });

    // A landing-URL visit carries no query; the handler must still start a
    // fresh authorization against the discovered endpoint.
    const url = new URL(registration.landingUrl);
    const { url: authorizeUrl } = await beginOidcLogin(
      {
        cookies: cookieStub(),
        params: { provider: 'happyvertical' },
        request: new Request(url),
        url,
      },
      options,
    );

    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      'https://idp.example.com/ui/oauth2',
    );
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      registration.redirectUri,
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe(kanidm.clientId);
  });
});
