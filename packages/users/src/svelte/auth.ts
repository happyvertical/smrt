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

export function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
