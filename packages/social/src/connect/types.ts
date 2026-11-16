/**
 * Social account connect flow: provider contract.
 *
 * A provider knows one platform's OAuth dialect (authorize URL, scopes, PKCE,
 * client authentication, token request, profile lookup). The flow in
 * `./flow.ts` owns everything shared: state, tenancy, secret storage, account
 * upsert. Hosts mount two routes and supply client credentials.
 */

import type { SocialPlatformType } from '../social-account.js';

/** Client credentials issued by the platform's developer console. */
export interface SocialClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Tokens returned by a platform token endpoint. */
export interface SocialTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  /** Absolute expiry of the access token, when the platform reports one. */
  expiresAt?: Date;
  scopes: string[];
}

/** The authenticated platform account. */
export interface SocialProfile {
  id: string;
  username: string;
  name?: string | null;
  url?: string | null;
}

export interface SocialAuthorizeRequest {
  client: SocialClientCredentials;
  redirectUri: string;
  state: string;
  scopes: string[];
  /** S256 challenge; present when the provider `usesPkce`. */
  codeChallenge?: string;
}

export interface SocialCodeExchange {
  client: SocialClientCredentials;
  redirectUri: string;
  code: string;
  codeVerifier?: string | null;
  fetch: typeof fetch;
}

export interface SocialConnectProvider {
  platform: SocialPlatformType;
  label: string;
  /** Environment variables a host sets to supply client credentials. */
  clientEnv: { clientId: string; clientSecret: string };
  defaultScopes: string[];
  usesPkce: boolean;
  buildAuthorizeUrl(request: SocialAuthorizeRequest): string;
  exchangeCode(request: SocialCodeExchange): Promise<SocialTokenSet>;
  fetchProfile(
    accessToken: string,
    fetchImpl: typeof fetch,
  ): Promise<SocialProfile>;
  /**
   * The credential payload stored in smrt-secrets. Includes client id/secret
   * so a publisher can refresh without extra configuration.
   */
  toCredentials(
    tokens: SocialTokenSet,
    profile: SocialProfile,
    client: SocialClientCredentials,
  ): Record<string, unknown>;
}

export type SocialConnectErrorCode =
  | 'unsupported_platform'
  | 'missing_client_credentials'
  | 'missing_tenant'
  | 'invalid_state'
  | 'state_expired'
  | 'access_denied'
  | 'provider_error'
  | 'token_exchange_failed'
  | 'profile_lookup_failed';

/**
 * Raised for every connect failure. Messages are safe to show to a user and
 * never contain tokens, codes, or client secrets.
 */
export class SocialConnectError extends Error {
  constructor(
    readonly code: SocialConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SocialConnectError';
  }
}
