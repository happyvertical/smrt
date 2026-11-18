import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginConnect,
  buildOAuth2AuthorizeUrl,
  ConnectError,
  ConnectStateCollection,
  type ConnectStateStore,
  consumeConnect,
  discoverOidcEndpoints,
  exchangeOAuth2Code,
  fetchOidcUserInfo,
  generateCodeChallenge,
  isSafeReturnPath,
} from '../connect/index.js';

const REDIRECT = 'https://app.example.com/connect/callback';

describe('credential connect kernel', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function begin(
    overrides: Partial<Parameters<typeof beginConnect>[0]> = {},
  ) {
    const store = (await ConnectStateCollection.create({ db })).asStore();
    const begun = await beginConnect({
      store,
      kind: 'mail:stalwart',
      tenantId: 't1',
      userId: 'u1',
      redirectUri: REDIRECT,
      scopes: ['openid', 'email'],
      usesPkce: true,
      ...overrides,
    });
    return { store, ...begun };
  }

  const consume = (
    store: ConnectStateStore,
    state: string,
    overrides: Partial<Parameters<typeof consumeConnect>[0]> = {},
  ) =>
    consumeConnect({
      store,
      kind: 'mail:stalwart',
      tenantId: 't1',
      userId: 'u1',
      redirectUri: REDIRECT,
      query: { code: 'c', state },
      label: 'Mail',
      ...overrides,
    });

  it('round-trips a single-use, tenant- and user-bound state with PKCE', async () => {
    await withTenant({ tenantId: 't1' }, async () => {
      const { store, state, codeChallenge } = await begin({
        returnTo: '/settings/mail',
      });
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const { record, code } = await consume(store, state);
      expect(code).toBe('c');
      expect(record.returnTo).toBe('/settings/mail');
      expect(await generateCodeChallenge(record.codeVerifier as string)).toBe(
        codeChallenge,
      );
      await expect(consume(store, state)).rejects.toMatchObject({
        code: 'invalid_state',
      });
    });
  });

  it('rejects a state used by another user, tenant, kind or redirect without spending it', async () => {
    await withTenant({ tenantId: 't1' }, async () => {
      const { store, state } = await begin();
      for (const override of [
        { userId: 'u2' },
        { userId: null },
        { kind: 'other' },
        { redirectUri: 'https://evil.example.com/cb' },
        { tenantId: 't2' },
      ]) {
        await expect(consume(store, state, override)).rejects.toMatchObject({
          code: 'invalid_state',
        });
      }
      await expect(consume(store, state)).resolves.toMatchObject({ code: 'c' });
    });
  });

  it('burns the state on a refused grant and on expiry', async () => {
    await withTenant({ tenantId: 't1' }, async () => {
      const denied = await begin();
      await expect(
        consume(denied.store, denied.state, {
          query: { state: denied.state, error: 'access_denied' },
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
      await expect(consume(denied.store, denied.state)).rejects.toMatchObject({
        code: 'invalid_state',
      });
      const expired = await begin({ ttlMs: -1 });
      await expect(consume(expired.store, expired.state)).rejects.toMatchObject(
        { code: 'state_expired' },
      );
      await expect(consume(expired.store, 'unknown')).rejects.toMatchObject({
        code: 'invalid_state',
      });
    });
  });

  it('lets only one of two racing callbacks consume a state', async () => {
    await withTenant({ tenantId: 't1' }, async () => {
      const { store, state } = await begin();
      const settled = await Promise.allSettled([
        consume(store, state),
        consume(store, state),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
  });

  it('accepts only same-origin return paths', async () => {
    expect(isSafeReturnPath('/settings/mail?tab=1')).toBe(true);
    for (const bad of [
      'https://evil.example.com',
      '//evil.example.com',
      '/\\evil.example.com',
      'settings',
      '/a\nb',
      '',
      null,
    ]) {
      expect(isSafeReturnPath(bad)).toBe(false);
    }
    await withTenant({ tenantId: 't1' }, async () => {
      await expect(
        begin({ returnTo: 'https://evil.example.com' }),
      ).rejects.toMatchObject({ code: 'invalid_return_to' });
    });
  });
});

describe('generic OAuth 2.0 / OIDC provider mechanics', () => {
  const config = {
    label: 'Mail',
    authorizeUrl: 'https://id.example.com/authorize',
    tokenUrl: 'https://id.example.com/token',
    userinfoUrl: 'https://id.example.com/userinfo',
  };
  const client = { clientId: 'cid', clientSecret: 'secret' };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it('builds a PKCE authorize URL', () => {
    const url = new URL(
      buildOAuth2AuthorizeUrl(config, {
        client,
        redirectUri: REDIRECT,
        state: 's',
        scopes: ['openid', 'email'],
        codeChallenge: 'chal',
      }),
    );
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_secret')).toBeNull();
  });

  it('exchanges a code with basic or post client authentication and never echoes the body', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      json({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: 'x y',
      }),
    );
    const tokens = await exchangeOAuth2Code(config, {
      client,
      redirectUri: REDIRECT,
      code: 'c',
      codeVerifier: 'v',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(tokens).toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
      scopes: ['x', 'y'],
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa('cid:secret')}`,
    );
    await exchangeOAuth2Code(
      { ...config, clientAuth: 'post' },
      {
        client,
        redirectUri: REDIRECT,
        code: 'c',
        fetch: fetchImpl as unknown as typeof fetch,
      },
    );
    const post = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect((post.body as URLSearchParams).get('client_secret')).toBe('secret');

    const failing = vi.fn(async () => json({ error: 'secret-detail' }, 400));
    const error = await exchangeOAuth2Code(config, {
      client,
      redirectUri: REDIRECT,
      code: 'c',
      fetch: failing as unknown as typeof fetch,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error.code).toBe('token_exchange_failed');
    expect(error.message).not.toContain('secret-detail');
  });

  it('reads OIDC userinfo and rejects an unusable response', async () => {
    const ok = vi.fn(async () => json({ sub: '1', email: 'a@example.com' }));
    await expect(
      fetchOidcUserInfo(config, 'tok', ok as unknown as typeof fetch),
    ).resolves.toMatchObject({ sub: '1', email: 'a@example.com' });
    const bad = vi.fn(async () => json({}, 401));
    await expect(
      fetchOidcUserInfo(config, 'tok', bad as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'profile_lookup_failed' });
  });

  it('discovers endpoints only when the issuer matches and URLs are https', async () => {
    const doc = (issuer: string, token = 'https://id.example.com/token') =>
      vi.fn(async () =>
        json({
          issuer,
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: token,
        }),
      ) as unknown as typeof fetch;
    await expect(
      discoverOidcEndpoints(
        'https://id.example.com/',
        'Mail',
        doc('https://id.example.com'),
      ),
    ).resolves.toMatchObject({ tokenUrl: 'https://id.example.com/token' });
    await expect(
      discoverOidcEndpoints(
        'https://id.example.com',
        'Mail',
        doc('https://evil.example.com'),
      ),
    ).rejects.toMatchObject({ code: 'discovery_failed' });
    await expect(
      discoverOidcEndpoints(
        'https://id.example.com',
        'Mail',
        doc('https://id.example.com', 'http://id.example.com/token'),
      ),
    ).rejects.toMatchObject({ code: 'discovery_failed' });
    await expect(
      discoverOidcEndpoints(
        'http://id.example.com',
        'Mail',
        doc('http://id.example.com'),
      ),
    ).rejects.toMatchObject({ code: 'discovery_failed' });
  });
});
