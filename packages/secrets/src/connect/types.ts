/**
 * Provider-neutral credential connect: shared contracts.
 *
 * "Connect" is how a credential reaches smrt-secrets for an external account
 * a user owns: an OAuth 2.0 / OIDC redirect flow, or a write-only secret the
 * user types (an app password, handled by the owning package). This kernel
 * owns what every flow shares, the single-use state record, PKCE, a safe
 * return path, generic OAuth 2.0 / OIDC provider mechanics and one error type.
 * smrt-social and smrt-messages each bring their own account upsert.
 */

export type ConnectErrorCode =
  | 'unsupported_provider'
  | 'missing_client_credentials'
  | 'missing_tenant'
  | 'invalid_state'
  | 'state_expired'
  | 'access_denied'
  | 'provider_error'
  | 'token_exchange_failed'
  | 'profile_lookup_failed'
  | 'discovery_failed'
  | 'invalid_return_to'
  | 'forbidden';

/**
 * Raised for every connect failure. Messages are safe to show to a user and
 * never contain tokens, codes or client secrets.
 */
export class ConnectError<
  Code extends string = ConnectErrorCode,
> extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

/** The persisted facts of one in-flight connect. */
export interface ConnectStateRecord {
  /** The unguessable value round-tripped through the provider. */
  state: string;
  /** Which provider/flow this state belongs to. */
  kind: string;
  codeVerifier: string | null;
  redirectUri: string;
  scopes: string[];
  tenantId: string | null;
  /** The signed-in user who started the connect. */
  initiatedByUserId: string | null;
  /** Same-origin path to return to after the callback. */
  returnTo?: string | null;
  expiresAt: Date;
}

export type NewConnectState = ConnectStateRecord;

/**
 * Where a package keeps its connect states. smrt-secrets ships
 * `ConnectStateCollection` for new flows; smrt-social adapts its own
 * `OAuthState` table to the same contract.
 */
export interface ConnectStateStore {
  create(input: NewConnectState): Promise<ConnectStateRecord>;
  findByState(state: string): Promise<ConnectStateRecord | null>;
  /**
   * Delete the record exactly once. Resolves `true` for the one caller that
   * removed it and `false` for every other racer.
   */
  consume(record: ConnectStateRecord): Promise<boolean>;
}

/** Client credentials issued by an OAuth provider's console. */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Tokens returned by a token endpoint. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  /** Absolute expiry of the access token, when the provider reports one. */
  expiresAt?: Date;
  scopes: string[];
}
