import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeSocialConnect,
  isSocialConnectConfigured,
  SocialConnectError,
  socialConnectHrefs,
  startSocialConnect,
  X_TOKEN_URL,
  xConnectProvider,
} from './connect.js';
import { OAuthStateCollection, SocialAccountCollection } from './index.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const REDIRECT = 'https://work.example.com/app/marketing/social/callback/x';
const env = { X_CLIENT_ID: 'client-id', X_CLIENT_SECRET: 'client-secret' };

async function withDb<T>(fn: (db: DatabaseInterface) => Promise<T>) {
  const db = await getTestDatabase({
    classes: ['SocialAccount', 'OAuthState', 'Secret', 'SecretAuditLog'],
  });
  try {
    return await fn(db);
  } finally {
    await db.close?.();
  }
}

function xFetch(
  options: { tokenStatus?: number; meStatus?: number; refresh?: boolean } = {},
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === X_TOKEN_URL) {
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(
        `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
      );
      const status = options.tokenStatus ?? 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? {
                access_token: 'access-1',
                refresh_token: 'refresh-1',
                token_type: 'bearer',
                expires_in: 7200,
                scope: 'tweet.read tweet.write users.read offline.access',
              }
            : { error: 'invalid_request' },
        ),
        { status },
      );
    }
    const status = options.meStatus ?? 200;
    return new Response(
      JSON.stringify({
        data: { id: '42', username: 'happyvertical', name: 'Happy Vertical' },
      }),
      { status },
    );
  });
}

function queryFrom(authorizeUrl: string) {
  const url = new URL(authorizeUrl);
  return { url, state: url.searchParams.get('state') as string };
}

describe('smrt-social connect flow (X)', () => {
  afterEach(() => {
    disableTenancy();
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

  it('builds a PKCE authorize URL and persists a tenant-bound state', async () => {
    enableTenancy();
    await withDb(async (db) => {
      const { authorizeUrl } = await startSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
      });
      const { url, state } = queryFrom(authorizeUrl);
      expect(url.origin + url.pathname).toBe(
        'https://x.com/i/oauth2/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('client-id');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toContain('tweet.write');
      expect(authorizeUrl).not.toContain('client-secret');

      const stored = await withTenant({ tenantId: 'tenant-a' }, async () =>
        (await OAuthStateCollection.create({ db })).findByState(state),
      );
      expect(stored?.tenantId).toBe('tenant-a');
      expect(stored?.codeVerifier).toBeTruthy();
    });
  });

  it('connects the account, stores Garrula-shaped credentials in secrets, starts in dry_run', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
    enableTenancy();
    await withDb(async (db) => {
      const { authorizeUrl } = await startSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
      });
      const { state } = queryFrom(authorizeUrl);
      const fetchMock = xFetch();

      const { account, created } = await completeSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
        fetch: fetchMock as unknown as typeof fetch,
        query: { code: 'auth-code', state },
      });

      expect(created).toBe(true);
      expect(account.platformUsername).toBe('happyvertical');
      expect(account.publishMode).toBe('dry_run');
      expect(account.status).toBe('connected');
      expect(account.tokenExpiresAt).toBeInstanceOf(Date);
      // No token lands in a plain column.
      expect(account.accessToken).toBeNull();
      expect(account.refreshToken).toBeNull();

      const credentials = await withTenant({ tenantId: 'tenant-a' }, () =>
        account.getCredentials(),
      );
      expect(credentials).toMatchObject({
        authType: 'oauth2',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        userId: '42',
      });
      expect(typeof credentials?.expiresAt).toBe('string');

      // The PKCE verifier reached the token endpoint.
      const tokenCall = fetchMock.mock.calls.find(
        ([u]) => String(u) === X_TOKEN_URL,
      );
      const tokenBody = tokenCall?.[1]?.body as URLSearchParams | undefined;
      expect(tokenBody?.get('code_verifier')).toBeTruthy();
    });
  });

  it('reconnecting updates the same account and never widens its publish mode', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
    enableTenancy();
    await withDb(async (db) => {
      const run = async () => {
        const { authorizeUrl } = await startSocialConnect({
          db,
          platform: 'x',
          tenantId: 'tenant-a',
          redirectUri: REDIRECT,
          env,
        });
        return completeSocialConnect({
          db,
          platform: 'x',
          tenantId: 'tenant-a',
          redirectUri: REDIRECT,
          env,
          fetch: xFetch() as unknown as typeof fetch,
          query: { code: 'c', state: queryFrom(authorizeUrl).state },
        });
      };
      const first = await run();
      first.account.publishMode = 'stage_remote';
      await withTenant({ tenantId: 'tenant-a' }, () => first.account.save());
      const second = await run();
      expect(second.created).toBe(false);
      expect(second.account.id).toBe(first.account.id);
      expect(second.account.publishMode).toBe('stage_remote');
      const all = await withTenant({ tenantId: 'tenant-a' }, async () =>
        (await SocialAccountCollection.create({ db })).list({}),
      );
      expect(all).toHaveLength(1);
    });
  });

  it('rejects an unknown or mismatched state and a replayed state', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
    enableTenancy();
    await withDb(async (db) => {
      const { authorizeUrl } = await startSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
      });
      const { state } = queryFrom(authorizeUrl);
      const base = {
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
        fetch: xFetch() as unknown as typeof fetch,
      };

      await expect(
        completeSocialConnect({
          ...base,
          query: { code: 'c', state: 'bogus' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      await expect(
        completeSocialConnect({ ...base, query: { code: 'c' } }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      // Another tenant cannot redeem tenant-a's state.
      await expect(
        completeSocialConnect({
          ...base,
          tenantId: 'tenant-b',
          query: { code: 'c', state },
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      // A different redirect URI does not match.
      await expect(
        completeSocialConnect({
          ...base,
          redirectUri: 'https://evil.example/cb',
          query: { code: 'c', state },
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });

      await completeSocialConnect({ ...base, query: { code: 'c', state } });
      await expect(
        completeSocialConnect({ ...base, query: { code: 'c', state } }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
    });
  });

  it('burns the state on a refused grant and creates no account', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
    enableTenancy();
    await withDb(async (db) => {
      const { authorizeUrl } = await startSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
      });
      const { state } = queryFrom(authorizeUrl);
      const fetchMock = xFetch();
      const base = {
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
        fetch: fetchMock as unknown as typeof fetch,
      };
      await expect(
        completeSocialConnect({
          ...base,
          query: { error: 'access_denied', state },
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(
        completeSocialConnect({ ...base, query: { code: 'c', state } }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      const accounts = await withTenant({ tenantId: 'tenant-a' }, async () =>
        (await SocialAccountCollection.create({ db })).list({}),
      );
      expect(accounts).toHaveLength(0);
    });
  });

  it('rejects an expired state', async () => {
    enableTenancy();
    await withDb(async (db) => {
      const { authorizeUrl } = await startSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
        ttlMs: -1000,
      });
      await expect(
        completeSocialConnect({
          db,
          platform: 'x',
          tenantId: 'tenant-a',
          redirectUri: REDIRECT,
          env,
          query: { code: 'c', state: queryFrom(authorizeUrl).state },
        }),
      ).rejects.toMatchObject({ code: 'state_expired' });
    });
  });

  it('surfaces a token exchange failure without leaking the response', async () => {
    enableTenancy();
    await withDb(async (db) => {
      const { authorizeUrl } = await startSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
      });
      const error = await completeSocialConnect({
        db,
        platform: 'x',
        tenantId: 'tenant-a',
        redirectUri: REDIRECT,
        env,
        fetch: xFetch({ tokenStatus: 400 }) as unknown as typeof fetch,
        query: { code: 'c', state: queryFrom(authorizeUrl).state },
      }).catch((e) => e);
      expect(error).toBeInstanceOf(SocialConnectError);
      expect(error.code).toBe('token_exchange_failed');
      expect(error.message).not.toContain('invalid_request');
    });
  });

  it('requires configured client credentials, a tenant, and a known platform', async () => {
    enableTenancy();
    await withDb(async (db) => {
      const base = { db, redirectUri: REDIRECT, tenantId: 'tenant-a' };
      await expect(
        startSocialConnect({ ...base, platform: 'x', env: {} }),
      ).rejects.toMatchObject({ code: 'missing_client_credentials' });
      await expect(
        startSocialConnect({ db, redirectUri: REDIRECT, platform: 'x', env }),
      ).rejects.toMatchObject({ code: 'missing_tenant' });
      await expect(
        startSocialConnect({ ...base, platform: 'myspace', env }),
      ).rejects.toMatchObject({ code: 'unsupported_platform' });
    });
    expect(isSocialConnectConfigured('x', { env })).toBe(true);
    expect(isSocialConnectConfigured('x', { env: {} })).toBe(false);
  });

  it('exposes hrefs for SocialAccountSettings', () => {
    expect(socialConnectHrefs('/app/marketing/social/connect/')).toEqual({
      x: '/app/marketing/social/connect/x',
    });
    expect(xConnectProvider.clientEnv.clientId).toBe('X_CLIENT_ID');
  });
});
