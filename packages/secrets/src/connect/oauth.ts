import {
  ConnectError,
  type OAuthClientCredentials,
  type OAuthTokenSet,
} from './types.js';

/** A fully resolved OAuth 2.0 authorization-code provider. */
export interface OAuth2Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
}

export interface OAuth2ProviderConfig extends OAuth2Endpoints {
  /** Shown in user-facing messages. */
  label: string;
  /** How the client authenticates at the token endpoint. Default `basic`. */
  clientAuth?: 'basic' | 'post';
  /** Extra static authorize parameters, for example `access_type=offline`. */
  authorizeParams?: Record<string, string>;
}

export interface OAuth2AuthorizeRequest {
  client: OAuthClientCredentials;
  redirectUri: string;
  state: string;
  scopes: string[];
  codeChallenge?: string;
}

export function buildOAuth2AuthorizeUrl(
  config: OAuth2ProviderConfig,
  request: OAuth2AuthorizeRequest,
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.client.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  if (request.scopes.length) {
    url.searchParams.set('scope', request.scopes.join(' '));
  }
  url.searchParams.set('state', request.state);
  if (request.codeChallenge) {
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(config.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface TokenBody {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** Exchange an authorization code. Never echoes the response body. */
export async function exchangeOAuth2Code(
  config: OAuth2ProviderConfig,
  request: {
    client: OAuthClientCredentials;
    redirectUri: string;
    code: string;
    codeVerifier?: string | null;
    fetch: typeof fetch;
  },
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.client.clientId,
  });
  if (request.codeVerifier) body.set('code_verifier', request.codeVerifier);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if ((config.clientAuth ?? 'basic') === 'basic') {
    headers.authorization = `Basic ${btoa(
      `${request.client.clientId}:${request.client.clientSecret}`,
    )}`;
  } else {
    body.set('client_secret', request.client.clientSecret);
  }
  const response = await request.fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body,
  });
  const json = (await response.json().catch(() => null)) as TokenBody | null;
  if (
    !response.ok ||
    typeof json?.access_token !== 'string' ||
    !json.access_token
  ) {
    throw new ConnectError(
      'token_exchange_failed',
      `${config.label} rejected the authorization code (HTTP ${response.status}).`,
    );
  }
  const tokens: OAuthTokenSet = {
    accessToken: json.access_token,
    tokenType:
      typeof json.token_type === 'string' ? json.token_type : undefined,
    scopes:
      typeof json.scope === 'string' && json.scope ? json.scope.split(' ') : [],
  };
  if (typeof json.refresh_token === 'string' && json.refresh_token) {
    tokens.refreshToken = json.refresh_token;
  }
  if (typeof json.expires_in === 'number') {
    tokens.expiresAt = new Date(Date.now() + json.expires_in * 1000);
  }
  return tokens;
}

/** OpenID Connect `userinfo` claims the connect flows read. */
export interface OidcUserInfo {
  sub: string;
  email?: string;
  preferredUsername?: string;
  name?: string;
}

export async function fetchOidcUserInfo(
  config: Pick<OAuth2ProviderConfig, 'label' | 'userinfoUrl'>,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<OidcUserInfo> {
  if (!config.userinfoUrl) {
    throw new ConnectError(
      'profile_lookup_failed',
      `${config.label} has no userinfo endpoint configured.`,
    );
  }
  const response = await fetchImpl(config.userinfoUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  const json = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || typeof json?.sub !== 'string' || !json.sub) {
    throw new ConnectError(
      'profile_lookup_failed',
      `Could not read the ${config.label} profile after connecting (HTTP ${response.status}).`,
    );
  }
  const text = (value: unknown) =>
    typeof value === 'string' && value ? value : undefined;
  return {
    sub: json.sub,
    email: text(json.email),
    preferredUsername: text(json.preferred_username),
    name: text(json.name),
  };
}

function requireHttps(url: unknown, what: string, label: string): string {
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(
        parsed.hostname,
      );
      if (
        parsed.protocol === 'https:' ||
        (local && parsed.protocol === 'http:')
      ) {
        return parsed.toString();
      }
    } catch {
      // fall through
    }
  }
  throw new ConnectError(
    'discovery_failed',
    `${label} returned an unusable ${what}.`,
  );
}

/**
 * Resolve endpoints from an OIDC issuer's discovery document
 * (`/.well-known/openid-configuration`). The document's own `issuer` must equal
 * the configured one, so a hijacked path cannot redirect the flow elsewhere.
 */
export async function discoverOidcEndpoints(
  issuer: string,
  label: string,
  fetchImpl: typeof fetch,
): Promise<OAuth2Endpoints> {
  const base = requireHttps(issuer, 'issuer', label).replace(/\/$/, '');
  const response = await fetchImpl(`${base}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
  });
  const json = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !response.ok ||
    typeof json?.issuer !== 'string' ||
    json.issuer.replace(/\/$/, '') !== base
  ) {
    throw new ConnectError(
      'discovery_failed',
      `Could not discover ${label} sign-in endpoints (HTTP ${response.status}).`,
    );
  }
  return {
    authorizeUrl: requireHttps(
      json.authorization_endpoint,
      'authorization endpoint',
      label,
    ),
    tokenUrl: requireHttps(json.token_endpoint, 'token endpoint', label),
    userinfoUrl: json.userinfo_endpoint
      ? requireHttps(json.userinfo_endpoint, 'userinfo endpoint', label)
      : undefined,
  };
}
