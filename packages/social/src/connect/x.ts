/**
 * X (Twitter) connect provider: OAuth 2.0 authorization code with PKCE and a
 * confidential client (HTTP Basic client authentication).
 */

import type {
  SocialClientCredentials,
  SocialConnectProvider,
  SocialProfile,
  SocialTokenSet,
} from './types.js';
import { SocialConnectError } from './types.js';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_ME_URL = 'https://api.x.com/2/users/me';

export const X_DEFAULT_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access',
  'media.write',
];

function basicAuth({
  clientId,
  clientSecret,
}: SocialClientCredentials): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

interface XTokenBody {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export const xConnectProvider: SocialConnectProvider = {
  platform: 'x',
  label: 'X',
  clientEnv: { clientId: 'X_CLIENT_ID', clientSecret: 'X_CLIENT_SECRET' },
  defaultScopes: X_DEFAULT_SCOPES,
  usesPkce: true,

  buildAuthorizeUrl({ client, redirectUri, state, scopes, codeChallenge }) {
    const url = new URL(X_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    if (codeChallenge) {
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  },

  async exchangeCode({
    client,
    redirectUri,
    code,
    codeVerifier,
    fetch: fetchImpl,
  }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
    });
    if (codeVerifier) body.set('code_verifier', codeVerifier);

    const response = await fetchImpl(X_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuth(client),
      },
      body,
    });
    const json = (await response.json().catch(() => null)) as XTokenBody | null;
    if (
      !response.ok ||
      typeof json?.access_token !== 'string' ||
      !json.access_token
    ) {
      // Never echo the response body: it can carry provider detail we do not
      // control. Status is enough to debug.
      throw new SocialConnectError(
        'token_exchange_failed',
        `X rejected the authorization code (HTTP ${response.status}).`,
      );
    }
    const tokens: SocialTokenSet = {
      accessToken: json.access_token,
      tokenType:
        typeof json.token_type === 'string' ? json.token_type : undefined,
      scopes:
        typeof json.scope === 'string' && json.scope
          ? json.scope.split(' ')
          : [],
    };
    if (typeof json.refresh_token === 'string' && json.refresh_token) {
      tokens.refreshToken = json.refresh_token;
    }
    if (typeof json.expires_in === 'number') {
      tokens.expiresAt = new Date(Date.now() + json.expires_in * 1000);
    }
    return tokens;
  },

  async fetchProfile(accessToken, fetchImpl): Promise<SocialProfile> {
    const response = await fetchImpl(X_ME_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json = (await response.json().catch(() => null)) as {
      data?: { id?: unknown; username?: unknown; name?: unknown };
    } | null;
    const data = json?.data;
    if (
      !response.ok ||
      typeof data?.id !== 'string' ||
      typeof data.username !== 'string'
    ) {
      throw new SocialConnectError(
        'profile_lookup_failed',
        `Could not read the X profile after connecting (HTTP ${response.status}).`,
      );
    }
    return {
      id: data.id,
      username: data.username,
      name: typeof data.name === 'string' ? data.name : null,
      url: `https://x.com/${data.username}`,
    };
  },

  // The shape @happyvertical/garrula reads for X OAuth 2.0 user tokens.
  toCredentials(tokens, profile, client) {
    const credentials: Record<string, unknown> = {
      authType: 'oauth2',
      accessToken: tokens.accessToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      userId: profile.id,
      scopes: tokens.scopes,
    };
    if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
    if (tokens.tokenType) credentials.tokenType = tokens.tokenType;
    if (tokens.expiresAt) {
      credentials.expiresAt = tokens.expiresAt.toISOString();
      credentials.tokenExpiresAt = credentials.expiresAt;
    }
    return credentials;
  },
};
