/** Browser-facing callbacks supplied by the host application's auth boundary. */
/**
 * Client-side bridge to authorized server actions. Construct this in the
 * application boundary; do not put service secrets, session ids, or API-key
 * material in the browser. Password actions should delegate to
 * `createPasswordCredentialHandlers()`, magic links to `MagicLinkService`,
 * OIDC to `OidcLoginService`, and revocations to a server action that first
 * proves account ownership.
 */
export interface UsersAuthAdapter {
  signInWithPassword?(input: {
    email: string;
    password: string;
  }): Promise<void>;
  signUp?(input: { email: string; password: string }): Promise<void>;
  requestMagicLink?(input: { email: string }): Promise<void>;
  confirmMagicLink?(input: { token: string }): Promise<void>;
  signInWithOidc?(input: { providerId: string }): Promise<void>;
  /** Provided only after #3275's server-side WebAuthn ceremony is installed. */
  signInWithPasskey?(): Promise<void>;
  revokeSession?(sessionId: string): Promise<void>;
  revokeApiKey?(apiKeyId: string): Promise<void>;
}

export interface OidcProviderButton {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface AccountSession {
  id: string;
  label: string;
  lastActiveAt?: string;
  current?: boolean;
}

/** Deliberately excludes API-key secrets: security UIs only receive metadata. */
export interface AccountApiKey {
  id: string;
  label: string;
  createdAt?: string;
  lastUsedAt?: string;
}

/** Application endpoints whose server actions bind to the supported users services. */
export interface UsersAuthEndpointOptions {
  fetch?: typeof fetch;
  endpoints?: Partial<Record<keyof UsersAuthAdapter, string>>;
}

const DEFAULT_ENDPOINTS: Record<keyof UsersAuthAdapter, string> = {
  signInWithPassword: '/auth/password/sign-in',
  signUp: '/auth/sign-up',
  requestMagicLink: '/auth/magic-link/request',
  confirmMagicLink: '/auth/magic-link/confirm',
  signInWithOidc: '/auth/oidc/sign-in',
  signInWithPasskey: '/auth/passkey/sign-in',
  revokeSession: '/account/sessions/revoke',
  revokeApiKey: '/account/api-keys/revoke',
};

/**
 * Creates an adapter that posts to application-owned, authorized endpoints.
 * These endpoints must call the users services server-side; this helper does
 * not grant authorization in the browser.
 */
export function createUsersAuthAdapter(
  options: UsersAuthEndpointOptions = {},
): UsersAuthAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const post = async (endpoint: string, body?: unknown) => {
    const response = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Authentication request was refused.');
  };
  return {
    signInWithPassword: (input) => post(endpoints.signInWithPassword, input),
    signUp: (input) => post(endpoints.signUp, input),
    requestMagicLink: (input) => post(endpoints.requestMagicLink, input),
    confirmMagicLink: (input) => post(endpoints.confirmMagicLink, input),
    signInWithOidc: (input) => post(endpoints.signInWithOidc, input),
    signInWithPasskey: () => post(endpoints.signInWithPasskey),
    revokeSession: (sessionId) => post(endpoints.revokeSession, { sessionId }),
    revokeApiKey: (apiKeyId) => post(endpoints.revokeApiKey, { apiKeyId }),
  };
}

export function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
