/**
 * OidcLoginService - OAuth2/OIDC authorization-code login with PKCE.
 *
 * The service is provider-generic and works with standards-compliant IdPs such
 * as Kanidm, Dex, Keycloak, Authentik, Google, and others. It handles provider
 * discovery, authorization URL construction, token exchange, ID token
 * verification, and SMRT User/Profile creation.
 *
 * @packageDocumentation
 */

import { getPackageConfig } from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import {
  type OidcClaims,
  type OidcIdentityResult,
  UserCollection,
} from '../collections/UserCollection.js';

const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 15;
const DEFAULT_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const WELL_KNOWN_PATH = '/.well-known/openid-configuration';

export type OidcProviderKind = 'kanidm' | 'dex' | 'generic';

export type OidcTokenEndpointAuthMethod =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'none';

export interface OidcProviderConfig {
  /**
   * Optional preset label for documentation and UI.
   *
   * Kanidm and Dex are standards-compliant OIDC providers, so the preset does
   * not change protocol behavior; it lets apps name their intent clearly.
   */
  kind?: OidcProviderKind;
  /** OIDC issuer URL, e.g. https://id.example.com/dex */
  issuer: string;
  /** OAuth2/OIDC client ID registered with the provider */
  clientId: string;
  /** OAuth2/OIDC client secret for confidential clients */
  clientSecret?: string;
  /**
   * Redirect URI registered with the provider.
   *
   * SvelteKit helpers can derive this from the current request when omitted.
   */
  redirectUri?: string;
  /** Scopes to request. Defaults to openid profile email. */
  scopes?: string[];
  /** Override the discovery document URL when needed. */
  discoveryUrl?: string;
  /** Additional authorization request parameters. */
  authorizationParams?: Record<string, string | number | boolean | undefined>;
  /**
   * Client authentication method for the token endpoint.
   *
   * Defaults to client_secret_basic when clientSecret exists, otherwise none.
   */
  tokenEndpointAuthMethod?: OidcTokenEndpointAuthMethod;
}

export interface OidcProviderResolutionOptions {
  defaultProvider?: string;
  providers?: Record<string, OidcProviderConfig>;
}

export interface UsersOidcConfig extends OidcProviderResolutionOptions {
  /** Seconds before login transaction cookies expire. */
  transactionTtl?: number;
}

export interface OidcProviderResolution {
  provider: OidcProviderConfig;
  providerName: string;
}

export interface ResolvedOidcProviderConfig extends OidcProviderConfig {
  redirectUri: string;
}

export interface OidcProviderMetadata {
  authorization_endpoint: string;
  end_session_endpoint?: string;
  issuer: string;
  jwks_uri: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  [key: string]: unknown;
}

export interface OidcTransaction {
  codeVerifier: string;
  createdAt: number;
  nonce: string;
  provider: string;
  returnTo?: string;
  state: string;
}

export interface CreateAuthorizationUrlOptions {
  authorizationParams?: Record<string, string | number | boolean | undefined>;
  transaction?: OidcTransaction;
}

export interface OidcTokenSet {
  accessToken?: string;
  expiresAt?: Date;
  idToken: string;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
}

export interface OidcCallbackResult {
  claims: OidcClaims;
  tokens: OidcTokenSet;
}

export interface OidcLoginResult extends OidcIdentityResult {
  claims: OidcClaims;
  tokens: OidcTokenSet;
}

export interface OidcLoginServiceOptions extends SmrtClassOptions {
  /** Provider key, e.g. kanidm or dex */
  providerName: string;
  /** Fully resolved provider config. redirectUri is required here. */
  provider: ResolvedOidcProviderConfig;
  /** Optional fetch override for tests or custom runtimes. */
  fetch?: typeof fetch;
  /** JWT clock tolerance passed to jose. Defaults to 15 seconds. */
  clockTolerance?: number | string;
  /** Provider metadata cache TTL in milliseconds. Defaults to 5 minutes. */
  metadataCacheTtlMs?: number;
}

export class OidcLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcLoginError';
  }
}

interface UsersAuthPackageConfig extends Record<string, unknown> {
  auth?: {
    oidc?: UsersOidcConfig;
  };
}

interface TokenEndpointResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

type OidcClaimSource = JWTPayload | Record<string, unknown>;

export function getUsersOidcConfig(): UsersOidcConfig {
  const config = getPackageConfig<UsersAuthPackageConfig>('users', {});
  return config.auth?.oidc ?? {};
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/u, '');
}

function resolveDiscoveryUrl(provider: OidcProviderConfig): string {
  if (provider.discoveryUrl) return provider.discoveryUrl;
  return `${normalizeIssuer(provider.issuer)}${WELL_KNOWN_PATH}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function pkceChallenge(codeVerifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function formUrlEncode(value: string): string {
  const params = new URLSearchParams();
  params.set('value', value);
  return params.toString().slice('value='.length);
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  const credentials = `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`;
  return bytesToBase64(new TextEncoder().encode(credentials));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function ensureFetch(fetchOverride?: typeof fetch): typeof fetch {
  const runtimeFetch = fetchOverride ?? globalThis.fetch;
  if (!runtimeFetch) {
    throw new OidcLoginError('OIDC login requires a fetch implementation.');
  }
  return runtimeFetch;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OidcLoginError(`OIDC provider metadata missing "${field}".`);
  }
  return value;
}

async function readJsonResponse<T>(
  response: Response,
  context: string,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new OidcLoginError(`${context} returned invalid JSON.`);
  }
}

function normalizeClaims(
  payload: OidcClaimSource,
  issuer: string,
  sourceName = 'OIDC claims',
): OidcClaims {
  const sub = asString(payload.sub);
  if (!sub) {
    throw new OidcLoginError(`${sourceName} missing required "sub" claim.`);
  }

  return {
    sub,
    iss: asString(payload.iss) ?? issuer,
    email: asString(payload.email),
    email_verified: asBoolean(payload.email_verified),
    name: asString(payload.name),
    preferred_username: asString(payload.preferred_username),
  };
}

function mergeClaims(
  idTokenClaims: OidcClaims,
  userInfoClaims: OidcClaims,
): OidcClaims {
  if (userInfoClaims.sub !== idTokenClaims.sub) {
    throw new OidcLoginError('OIDC userinfo subject does not match ID token.');
  }

  return {
    ...idTokenClaims,
    email: idTokenClaims.email ?? userInfoClaims.email,
    email_verified:
      idTokenClaims.email_verified ?? userInfoClaims.email_verified,
    name: idTokenClaims.name ?? userInfoClaims.name,
    preferred_username:
      idTokenClaims.preferred_username ?? userInfoClaims.preferred_username,
  };
}

function validateAuthorizedParty(payload: JWTPayload, clientId: string): void {
  const authorizedParty = asString(payload.azp);

  if (authorizedParty && authorizedParty !== clientId) {
    throw new OidcLoginError('OIDC authorized party validation failed.');
  }

  if (
    Array.isArray(payload.aud) &&
    payload.aud.length > 1 &&
    authorizedParty !== clientId
  ) {
    throw new OidcLoginError('OIDC authorized party validation failed.');
  }
}

function getTokenEndpointAuthMethod(
  provider: OidcProviderConfig,
): OidcTokenEndpointAuthMethod {
  return (
    provider.tokenEndpointAuthMethod ??
    (provider.clientSecret ? 'client_secret_basic' : 'none')
  );
}

function getScopes(provider: OidcProviderConfig): string[] {
  return provider.scopes?.length ? provider.scopes : [...DEFAULT_SCOPES];
}

function parseTokenResponse(json: TokenEndpointResponse): OidcTokenSet {
  if (typeof json.id_token !== 'string') {
    throw new OidcLoginError('OIDC token response missing "id_token".');
  }

  return {
    accessToken: asString(json.access_token),
    expiresAt:
      typeof json.expires_in === 'number'
        ? new Date(Date.now() + json.expires_in * 1000)
        : undefined,
    idToken: json.id_token,
    refreshToken: asString(json.refresh_token),
    scope: asString(json.scope),
    tokenType: asString(json.token_type),
  };
}

function parseTransaction(value: unknown): OidcTransaction {
  if (!value || typeof value !== 'object') {
    throw new OidcLoginError('Invalid OIDC login transaction.');
  }

  const record = value as Partial<OidcTransaction>;
  if (
    !record.provider ||
    !record.state ||
    !record.nonce ||
    !record.codeVerifier ||
    typeof record.createdAt !== 'number'
  ) {
    throw new OidcLoginError('Invalid OIDC login transaction.');
  }

  return {
    codeVerifier: record.codeVerifier,
    createdAt: record.createdAt,
    nonce: record.nonce,
    provider: record.provider,
    returnTo: asString(record.returnTo),
    state: record.state,
  };
}

export function encodeOidcTransaction(transaction: OidcTransaction): string {
  const json = JSON.stringify(transaction);
  return bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeOidcTransaction(value: string): OidcTransaction {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(value));
    return parseTransaction(JSON.parse(json));
  } catch (error) {
    if (error instanceof OidcLoginError) throw error;
    throw new OidcLoginError('Invalid OIDC login transaction.');
  }
}

export function resolveOidcProviderConfig(
  providerName?: string,
  options: OidcProviderResolutionOptions = {},
): OidcProviderResolution {
  const oidcConfig = getUsersOidcConfig();
  const providers = {
    ...(oidcConfig.providers ?? {}),
    ...(options.providers ?? {}),
  };
  const resolvedProviderName =
    providerName ?? options.defaultProvider ?? oidcConfig.defaultProvider;

  if (!resolvedProviderName) {
    throw new OidcLoginError(
      'No OIDC provider specified. Pass a provider name or configure packages.users.auth.oidc.defaultProvider.',
    );
  }

  const provider = providers[resolvedProviderName];
  if (!provider) {
    throw new OidcLoginError(
      `Unknown OIDC provider "${resolvedProviderName}". Configure it under packages.users.auth.oidc.providers.`,
    );
  }

  if (!provider.issuer || !provider.clientId) {
    throw new OidcLoginError(
      `OIDC provider "${resolvedProviderName}" requires issuer and clientId.`,
    );
  }

  return {
    provider,
    providerName: resolvedProviderName,
  };
}

export class OidcLoginService {
  private readonly classOptions: SmrtClassOptions;
  private readonly clockTolerance: number | string;
  private readonly fetchImpl: typeof fetch;
  private readonly metadataCacheTtlMs: number;
  private metadataFetchedAt = 0;
  private metadataPromise?: Promise<OidcProviderMetadata>;
  private remoteJwks?: JWTVerifyGetKey;
  readonly provider: ResolvedOidcProviderConfig;
  readonly providerName: string;

  constructor(options: OidcLoginServiceOptions) {
    const {
      clockTolerance,
      fetch: fetchOverride,
      metadataCacheTtlMs,
      provider,
      providerName,
      ...classOptions
    } = options;

    if (!provider.redirectUri) {
      throw new OidcLoginError(
        `OIDC provider "${providerName}" requires a redirectUri.`,
      );
    }

    this.classOptions = classOptions;
    this.clockTolerance = clockTolerance ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
    this.fetchImpl = ensureFetch(fetchOverride);
    this.metadataCacheTtlMs =
      metadataCacheTtlMs ?? DEFAULT_METADATA_CACHE_TTL_MS;
    this.provider = {
      ...provider,
      issuer: normalizeIssuer(provider.issuer),
    };
    this.providerName = providerName;
  }

  createTransaction(returnTo?: string): OidcTransaction {
    return {
      codeVerifier: randomBase64Url(32),
      createdAt: Date.now(),
      nonce: randomBase64Url(32),
      provider: this.providerName,
      returnTo,
      state: randomBase64Url(32),
    };
  }

  async getMetadata(): Promise<OidcProviderMetadata> {
    const cacheExpired =
      this.metadataFetchedAt > 0 &&
      Date.now() - this.metadataFetchedAt > this.metadataCacheTtlMs;

    if (!this.metadataPromise || cacheExpired) {
      this.metadataPromise = this.fetchMetadata()
        .then((metadata) => {
          this.metadataFetchedAt = Date.now();
          this.remoteJwks = undefined;
          return metadata;
        })
        .catch((error) => {
          this.metadataPromise = undefined;
          throw error;
        });
    }

    return this.metadataPromise;
  }

  private async fetchMetadata(): Promise<OidcProviderMetadata> {
    const discoveryUrl = resolveDiscoveryUrl(this.provider);
    const response = await this.fetchImpl(discoveryUrl, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new OidcLoginError(
        `OIDC discovery failed for "${this.providerName}" (${response.status}).`,
      );
    }

    const metadata = await readJsonResponse<Partial<OidcProviderMetadata>>(
      response,
      'OIDC discovery',
    );
    const issuer = requireString(
      metadata.issuer ?? this.provider.issuer,
      'issuer',
    );

    if (normalizeIssuer(issuer) !== this.provider.issuer) {
      throw new OidcLoginError(
        `OIDC discovery issuer mismatch for "${this.providerName}".`,
      );
    }

    return {
      ...metadata,
      authorization_endpoint: requireString(
        metadata.authorization_endpoint,
        'authorization_endpoint',
      ),
      issuer,
      jwks_uri: requireString(metadata.jwks_uri, 'jwks_uri'),
      token_endpoint: requireString(metadata.token_endpoint, 'token_endpoint'),
    };
  }

  async createAuthorizationUrl(
    options: CreateAuthorizationUrlOptions = {},
  ): Promise<{ transaction: OidcTransaction; url: URL }> {
    const metadata = await this.getMetadata();
    const transaction = options.transaction ?? this.createTransaction();
    const codeChallenge = await pkceChallenge(transaction.codeVerifier);
    const url = new URL(metadata.authorization_endpoint);

    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.provider.clientId);
    url.searchParams.set('redirect_uri', this.provider.redirectUri);
    url.searchParams.set('scope', getScopes(this.provider).join(' '));
    url.searchParams.set('state', transaction.state);
    url.searchParams.set('nonce', transaction.nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    for (const [key, value] of Object.entries({
      ...this.provider.authorizationParams,
      ...options.authorizationParams,
    })) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return { transaction, url };
  }

  async exchangeCallback(
    callbackUrl: string | URL,
    transaction: OidcTransaction,
  ): Promise<OidcCallbackResult> {
    const code = this.validateCallback(callbackUrl, transaction);
    const tokens = await this.exchangeCode(code, transaction);
    const idTokenClaims = await this.verifyIdToken(
      tokens.idToken,
      transaction.nonce,
    );
    const claims = await this.enrichClaimsFromUserInfo(idTokenClaims, tokens);

    return { claims, tokens };
  }

  async completeLogin(
    callbackUrl: string | URL,
    transaction: OidcTransaction,
  ): Promise<OidcLoginResult> {
    const { claims, tokens } = await this.exchangeCallback(
      callbackUrl,
      transaction,
    );
    const users = await UserCollection.create(this.classOptions);
    const result = await users.getOrCreateFromOidc(claims, this.providerName);

    return {
      ...result,
      claims,
      tokens,
    };
  }

  private validateCallback(
    callbackUrl: string | URL,
    transaction: OidcTransaction,
  ): string {
    if (transaction.provider !== this.providerName) {
      throw new OidcLoginError('OIDC login transaction provider mismatch.');
    }

    const url = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description');
      throw new OidcLoginError(
        description
          ? `OIDC provider returned "${error}": ${description}`
          : `OIDC provider returned "${error}".`,
      );
    }

    const state = url.searchParams.get('state');
    if (!state || state !== transaction.state) {
      throw new OidcLoginError('OIDC state validation failed.');
    }

    const responseIssuer = url.searchParams.get('iss');
    if (
      responseIssuer &&
      normalizeIssuer(responseIssuer) !== this.provider.issuer
    ) {
      throw new OidcLoginError('OIDC response issuer validation failed.');
    }

    const code = url.searchParams.get('code');
    if (!code) {
      throw new OidcLoginError('OIDC callback missing authorization code.');
    }

    return code;
  }

  private async exchangeCode(
    code: string,
    transaction: OidcTransaction,
  ): Promise<OidcTokenSet> {
    const metadata = await this.getMetadata();
    const body = new URLSearchParams({
      code,
      code_verifier: transaction.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.provider.redirectUri,
    });
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    });

    const authMethod = getTokenEndpointAuthMethod(this.provider);
    if (authMethod === 'client_secret_basic') {
      if (!this.provider.clientSecret) {
        throw new OidcLoginError(
          `OIDC provider "${this.providerName}" is missing clientSecret.`,
        );
      }
      headers.set(
        'authorization',
        `Basic ${encodeBasicAuth(this.provider.clientId, this.provider.clientSecret)}`,
      );
    } else {
      body.set('client_id', this.provider.clientId);
      if (authMethod === 'client_secret_post') {
        if (!this.provider.clientSecret) {
          throw new OidcLoginError(
            `OIDC provider "${this.providerName}" is missing clientSecret.`,
          );
        }
        body.set('client_secret', this.provider.clientSecret);
      }
    }

    const response = await this.fetchImpl(metadata.token_endpoint, {
      body,
      headers,
      method: 'POST',
    });
    const json = await readJsonResponse<TokenEndpointResponse>(
      response,
      'OIDC token endpoint',
    );

    if (!response.ok) {
      const providerError = asString(json.error);
      const description = asString(json.error_description);
      throw new OidcLoginError(
        description
          ? `OIDC token exchange failed (${providerError ?? response.status}): ${description}`
          : `OIDC token exchange failed (${providerError ?? response.status}).`,
      );
    }

    return parseTokenResponse(json);
  }

  private async enrichClaimsFromUserInfo(
    claims: OidcClaims,
    tokens: OidcTokenSet,
  ): Promise<OidcClaims> {
    if (claims.email || !tokens.accessToken) {
      return claims;
    }

    const metadata = await this.getMetadata();
    if (!metadata.userinfo_endpoint) {
      return claims;
    }

    const tokenType = tokens.tokenType ?? 'Bearer';
    const response = await this.fetchImpl(metadata.userinfo_endpoint, {
      headers: {
        accept: 'application/json',
        authorization: `${tokenType} ${tokens.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new OidcLoginError(
        `OIDC userinfo request failed (${response.status}).`,
      );
    }

    const userInfo = await readJsonResponse<Record<string, unknown>>(
      response,
      'OIDC userinfo endpoint',
    );

    return mergeClaims(
      claims,
      normalizeClaims(userInfo, metadata.issuer, 'OIDC userinfo'),
    );
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<OidcClaims> {
    const metadata = await this.getMetadata();
    this.remoteJwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri), {
      [customFetch]: this.fetchImpl,
    });

    const { payload } = await jwtVerify(idToken, this.remoteJwks, {
      audience: this.provider.clientId,
      clockTolerance: this.clockTolerance,
      issuer: metadata.issuer,
    });

    validateAuthorizedParty(payload, this.provider.clientId);

    if (payload.nonce !== expectedNonce) {
      throw new OidcLoginError('OIDC nonce validation failed.');
    }

    return normalizeClaims(payload, metadata.issuer, 'OIDC ID token');
  }
}
