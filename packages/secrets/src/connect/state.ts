import {
  ConnectError,
  type ConnectStateRecord,
  type ConnectStateStore,
} from './types.js';

export const DEFAULT_CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

export function generateConnectState(): string {
  return crypto.randomUUID();
}

/** A PKCE code verifier (RFC 7636): 64 hex characters. */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** The S256 code challenge for a verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * A same-origin absolute path (`/settings/mail`), never a URL or a
 * protocol-relative or backslash form. Hosts redirect only to this.
 */
export function isSafeReturnPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export interface BeginConnectOptions {
  store: ConnectStateStore;
  kind: string;
  tenantId: string;
  userId?: string | null;
  redirectUri: string;
  scopes: string[];
  usesPkce: boolean;
  returnTo?: string | null;
  /** State lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
}

export interface BegunConnect {
  state: string;
  codeChallenge?: string;
}

/** Persist a single-use, tenant- and user-bound state. */
export async function beginConnect(
  options: BeginConnectOptions,
): Promise<BegunConnect> {
  if (options.returnTo != null && !isSafeReturnPath(options.returnTo)) {
    throw new ConnectError(
      'invalid_return_to',
      'The return path must be a same-origin path.',
    );
  }
  const state = generateConnectState();
  const codeVerifier = options.usesPkce ? generateCodeVerifier() : null;
  await options.store.create({
    state,
    kind: options.kind,
    codeVerifier,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    tenantId: options.tenantId,
    initiatedByUserId: options.userId ?? null,
    returnTo: options.returnTo ?? null,
    expiresAt: new Date(
      Date.now() + (options.ttlMs ?? DEFAULT_CONNECT_STATE_TTL_MS),
    ),
  });
  return {
    state,
    codeChallenge: codeVerifier
      ? await generateCodeChallenge(codeVerifier)
      : undefined,
  };
}

export interface ConsumeConnectOptions {
  store: ConnectStateStore;
  kind: string;
  tenantId: string;
  userId?: string | null;
  redirectUri: string;
  /** The callback's query parameters. */
  query: { code?: string | null; state?: string | null; error?: string | null };
  /** Used in user-facing messages, for example `X`. */
  label: string;
}

export interface ConsumedConnect {
  record: ConnectStateRecord;
  code: string;
}

/**
 * Verify a callback and burn its state. The state is consumed before anything
 * else, including for a refused grant, so a callback URL cannot be replayed;
 * a mismatched kind, tenant, redirect URI or user is rejected before the
 * state is spent.
 */
export async function consumeConnect(
  options: ConsumeConnectOptions,
): Promise<ConsumedConnect> {
  const { code, state: token, error } = options.query;
  const stored = token ? await options.store.findByState(token) : null;
  if (
    !stored ||
    stored.kind !== options.kind ||
    stored.tenantId !== options.tenantId ||
    stored.redirectUri !== options.redirectUri ||
    (stored.initiatedByUserId !== null &&
      stored.initiatedByUserId !== (options.userId ?? null))
  ) {
    throw new ConnectError(
      'invalid_state',
      'This connect link is not valid. Start the connection again.',
    );
  }
  if (!(await options.store.consume(stored))) {
    throw new ConnectError(
      'invalid_state',
      'This connect link was already used. Start the connection again.',
    );
  }
  if (Date.now() >= stored.expiresAt.getTime()) {
    throw new ConnectError(
      'state_expired',
      'This connect link expired. Start the connection again.',
    );
  }
  if (error) {
    throw new ConnectError(
      error === 'access_denied' ? 'access_denied' : 'provider_error',
      error === 'access_denied'
        ? `${options.label} access was not granted.`
        : `${options.label} returned an error (${error.slice(0, 64)}).`,
    );
  }
  if (!code) {
    throw new ConnectError(
      'provider_error',
      `${options.label} did not return an authorization code.`,
    );
  }
  return { record: stored, code };
}
