/**
 * Browser helpers for passkey sign-in and registration (#3275), over
 * `@simplewebauthn/browser` and the routes of
 * `createPasskeyCredentialHandlers()`. Browser-only and free of server
 * imports; the server holds every secret and decision.
 *
 * ```ts
 * const adapter = createUsersAuthAdapter({
 *   passkeyCeremony: createPasskeySignInCeremony(),
 * });
 * ```
 *
 * @packageDocumentation
 */

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';

/**
 * A passkey request the server refused. `code` is the server's error code
 * (`invalid_credentials`, `rate_limited`, `reauthentication_required`,
 * `passkey_registration`, `forbidden`, …) when it sent one; `message` is the
 * server's displayable text for `passkey_registration`, otherwise generic.
 */
export class PasskeyRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'PasskeyRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Whether this browser can run a passkey ceremony at all. */
export function browserSupportsPasskeys(): boolean {
  return typeof window !== 'undefined' && browserSupportsWebAuthn();
}

export interface CreatePasskeySignInCeremonyOptions {
  /** Default `/auth/passkey/options`. */
  optionsEndpoint?: string;
  /** Default `/auth/passkey/sign-in`. */
  signInEndpoint?: string;
  fetch?: typeof fetch;
}

export interface RegisterPasskeyOptions {
  /** Name shown in the person's passkey list; the server defaults and bounds it. */
  name?: string;
  /** Default `/account/passkeys/options`. */
  optionsEndpoint?: string;
  /** Default `/account/passkeys`. */
  registerEndpoint?: string;
  fetch?: typeof fetch;
}

async function postJson(
  request: typeof fetch,
  endpoint: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const response = await request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const parsed = (await response.json().catch(() => null)) as unknown;
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (!response.ok) {
    const code = typeof body.code === 'string' ? body.code : null;
    // Only the registration refusal is written for display; the rest stay
    // generic so a caller cannot surface server detail by accident.
    const message =
      code === 'passkey_registration' && typeof body.error === 'string'
        ? body.error
        : 'Authentication request was refused.';
    throw new PasskeyRequestError(response.status, code, message);
  }
  return body;
}

/**
 * A `passkeyCeremony` for `createUsersAuthAdapter`: fetch options, run the
 * browser's passkey prompt, post the assertion. Resolves once the server has
 * set the session cookie; throws {@link PasskeyRequestError} on a refusal and
 * the browser's own error (for example `NotAllowedError` when the person
 * dismisses the prompt) otherwise.
 */
export function createPasskeySignInCeremony(
  options: CreatePasskeySignInCeremonyOptions = {},
): () => Promise<void> {
  const {
    optionsEndpoint = '/auth/passkey/options',
    signInEndpoint = '/auth/passkey/sign-in',
  } = options;
  return async () => {
    const request = options.fetch ?? globalThis.fetch;
    const begun = await postJson(request, optionsEndpoint);
    const response = await startAuthentication({
      optionsJSON: begun.options as Parameters<
        typeof startAuthentication
      >[0]['optionsJSON'],
    });
    await postJson(request, signInEndpoint, {
      ceremonyId: begun.ceremonyId,
      response,
    });
  };
}

/**
 * Register a passkey for the signed-in person. Needs a recently minted
 * session: a `reauthentication_required` refusal means the person must sign
 * in again first. Resolves with the server's summary of the new passkey.
 */
export async function registerPasskey(
  options: RegisterPasskeyOptions = {},
): Promise<Record<string, unknown>> {
  const {
    name,
    optionsEndpoint = '/account/passkeys/options',
    registerEndpoint = '/account/passkeys',
  } = options;
  const request = options.fetch ?? globalThis.fetch;
  const begun = await postJson(request, optionsEndpoint);
  const response = await startRegistration({
    optionsJSON: begun.options as Parameters<
      typeof startRegistration
    >[0]['optionsJSON'],
  });
  const registered = await postJson(request, registerEndpoint, {
    ceremonyId: begun.ceremonyId,
    response,
    ...(name !== undefined && { name }),
  });
  return (registered.passkey ?? {}) as Record<string, unknown>;
}
