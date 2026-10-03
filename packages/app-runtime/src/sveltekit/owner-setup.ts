/**
 * Server half of the local owner-setup page (`src/routes/setup/+page.server.ts`).
 *
 * Owner bootstrap is local-profile only, loopback-only, and single-use. The
 * runtime stores only an HMAC of the short-lived token; this module never
 * stores, logs, or returns claim errors, and it re-checks loopback custody on
 * every request instead of trusting the bind host alone.
 */

import type { Cookies } from '@sveltejs/kit';
import { type ActionFailure, fail, redirect } from '@sveltejs/kit';
import type { LocalOwnerClaimResult } from '../index.js';
import { removeOnboardingHandoff } from '../state-root.js';
import type { SmrtSvelteKitRuntime } from './runtime.js';

/** Data returned by the setup page `load`. */
export interface OwnerSetupPageData {
  /** False when setup is claimed, disabled (deployed), or not loopback. */
  readonly available: boolean;
  /** One-time token from `?token=` (empty unless available). */
  readonly token: string;
}

/** Stable failure codes returned by the setup action. */
export type OwnerSetupErrorCode =
  /** Not the local profile (HTTP 404). */
  | 'setup_disabled'
  /** Request is not from a loopback client on a loopback host (HTTP 403). */
  | 'setup_unavailable'
  /** Missing token, blank name, or email without `@` (HTTP 400). */
  | 'setup_invalid_input'
  /** Token wrong, expired, or already used; owner already claimed (HTTP 400). */
  | 'setup_invalid';

/** `form` data returned with `fail(status, …)`. */
export interface OwnerSetupFailure {
  readonly code: OwnerSetupErrorCode;
  /** Fixed, secret-free message; never claim error text. */
  readonly message: string;
}

/** Form field names posted to the setup action. */
export const OWNER_SETUP_FIELDS = Object.freeze({
  token: 'token',
  name: 'name',
  email: 'email',
  tenantName: 'tenantName',
} as const);

export const DEFAULT_OWNER_SETUP_MESSAGES: Readonly<
  Record<OwnerSetupErrorCode, string>
> = Object.freeze({
  setup_disabled: 'Local owner setup is disabled.',
  setup_unavailable: 'Local owner setup is available only from this device.',
  setup_invalid_input: 'Name, email, and a valid setup token are required.',
  setup_invalid:
    'The setup invitation is invalid, expired, or already used. Run pnpm app:stop, pnpm app:recover, pnpm app:start, then pnpm app:open.',
});

/** The request fields the setup page reads. */
export interface OwnerSetupEvent {
  readonly url: URL;
  readonly locals: unknown;
  getClientAddress(): string;
}

export interface OwnerSetupActionEvent extends OwnerSetupEvent {
  readonly request: Request;
  readonly cookies: Pick<Cookies, 'set'>;
}

export interface OwnerSetupPageOptions {
  /** Where a signed-in visitor or a successful claim is sent. Default `/`. */
  readonly redirectTo?: string;
  /** Replace fixed failure messages (for example app-specific recovery steps). */
  readonly messages?: Partial<Record<OwnerSetupErrorCode, string>>;
  /** Override where the signed-in user comes from. Defaults to `locals.user`. */
  readonly resolveUser?: (event: OwnerSetupEvent) => unknown;
  /**
   * Set false to keep the `smrt app` onboarding hand-off files after a claim.
   * By default the runtime removes `onboarding.json` and
   * `onboarding-launch.html` from the private state root once the claim has
   * committed, so `pnpm app:open` stops offering the spent invitation.
   */
  readonly removeOnboardingHandoff?: boolean;
  /**
   * Best-effort extra cleanup after a successful claim (the hand-off files are
   * already removed by default). Errors are ignored: the owner and session are
   * already authoritative and a stale token now fails closed.
   */
  readonly onOwnerClaimed?: (
    result: LocalOwnerClaimResult,
    event: OwnerSetupActionEvent,
  ) => void | Promise<void>;
}

export interface OwnerSetupPage {
  readonly load: (event: OwnerSetupEvent) => Promise<OwnerSetupPageData>;
  readonly actions: {
    readonly default: (
      event: OwnerSetupActionEvent,
    ) => Promise<ActionFailure<OwnerSetupFailure>>;
  };
}

/**
 * Mount as `src/routes/setup/+page.server.ts`:
 *
 * ```ts
 * import { createOwnerSetupPage } from '@happyvertical/smrt-app-runtime/sveltekit';
 * import { runtime } from '../../hooks.server';
 *
 * export const { load, actions } = createOwnerSetupPage(runtime);
 * ```
 *
 * The form posts to the `default` action with fields `token` (hidden),
 * `name`, `email`, and optional `tenantName`. Success sets the session cookie
 * and redirects 303; failures return `fail(status, { code, message })`.
 */
export function createOwnerSetupPage(
  runtime: Pick<
    SmrtSvelteKitRuntime,
    'resolvedRuntime' | 'localRuntime' | 'sessionCookie'
  > &
    Partial<Pick<SmrtSvelteKitRuntime, 'applicationStateRoot'>>,
  options: OwnerSetupPageOptions = {},
): OwnerSetupPage {
  const redirectTo = options.redirectTo ?? '/';
  const messages = { ...DEFAULT_OWNER_SETUP_MESSAGES, ...options.messages };
  const failure = (status: number, code: OwnerSetupErrorCode) =>
    fail(status, { code, message: messages[code] } as OwnerSetupFailure);
  const resolveUser =
    options.resolveUser ??
    ((event: OwnerSetupEvent) => (event.locals as { user?: unknown }).user);

  const load = async (event: OwnerSetupEvent): Promise<OwnerSetupPageData> => {
    if (resolveUser(event)) redirect(303, redirectTo);
    const resolved = await runtime.resolvedRuntime();
    if (resolved.profile !== 'local' || !isLoopbackRequest(event)) {
      return { available: false, token: '' };
    }
    const local = await runtime.localRuntime();
    const diagnostics = await local.diagnostics();
    const available = diagnostics.bootstrap.status !== 'claimed';
    return {
      available,
      token: available
        ? event.url.searchParams.get(OWNER_SETUP_FIELDS.token) || ''
        : '',
    };
  };

  const claim = async (
    event: OwnerSetupActionEvent,
  ): Promise<ActionFailure<OwnerSetupFailure>> => {
    const resolved = await runtime.resolvedRuntime();
    if (resolved.profile !== 'local') return failure(404, 'setup_disabled');
    if (!isLoopbackRequest(event)) return failure(403, 'setup_unavailable');

    let form: FormData;
    try {
      form = await event.request.formData();
    } catch {
      return failure(400, 'setup_invalid_input');
    }
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const token = field(OWNER_SETUP_FIELDS.token);
    const name = field(OWNER_SETUP_FIELDS.name);
    const email = field(OWNER_SETUP_FIELDS.email);
    const tenantName = field(OWNER_SETUP_FIELDS.tenantName).trim();
    if (!token || !name.trim() || !email.includes('@')) {
      return failure(400, 'setup_invalid_input');
    }

    const local = await runtime.localRuntime();
    let result: LocalOwnerClaimResult;
    try {
      result = await local.claimOwner({
        token,
        name,
        email,
        ...(tenantName ? { tenantName } : {}),
        userAgent: event.request.headers.get('user-agent') || undefined,
        ipAddress: event.getClientAddress(),
      });
    } catch {
      return failure(400, 'setup_invalid');
    }

    const cookie = runtime.sessionCookie;
    event.cookies.set(cookie.name, result.sessionId, {
      path: cookie.path,
      ...(cookie.domain ? { domain: cookie.domain } : {}),
      httpOnly: true,
      secure: cookie.secure ?? event.url.protocol === 'https:',
      sameSite: cookie.sameSite,
      maxAge: cookie.maxAgeSeconds,
    });
    // claimOwner resolved, so the claim transaction has committed.
    if (
      options.removeOnboardingHandoff !== false &&
      runtime.applicationStateRoot
    ) {
      try {
        removeOnboardingHandoff(runtime.applicationStateRoot());
      } catch {
        // Best effort: the spent token already fails closed.
      }
    }
    try {
      await options.onOwnerClaimed?.(result, event);
    } catch {
      // Best effort only; see OwnerSetupPageOptions.onOwnerClaimed.
    }
    redirect(303, redirectTo);
  };

  return Object.freeze({
    load,
    actions: Object.freeze({ default: claim }),
  });
}

/**
 * True only when both the peer address and the addressed host are loopback.
 * The host check rejects tunnels and DNS-rebinding hosts that forward to a
 * loopback listener; a throwing `getClientAddress` is treated as remote.
 */
export function isLoopbackRequest(event: {
  readonly url: URL;
  getClientAddress(): string;
}): boolean {
  let address: string;
  try {
    address = event.getClientAddress();
  } catch {
    return false;
  }
  return isLoopbackAddress(address) && isLoopbackHostname(event.url.hostname);
}

/** Loopback IP literal: `127.0.0.0/8`, `::1`, or IPv4-mapped `127/8`. */
export function isLoopbackAddress(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  let host = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

/** Loopback host name as SvelteKit reports it in `url.hostname`. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || isLoopbackAddress(host);
}
