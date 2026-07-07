/**
 * TypeScript wire types for the `/api/mobile` auth + session contract.
 *
 * These are the SAME shapes the framework Kotlin contract ships to mobile
 * clients (`MOBILE_AUTH_CONTRACT_KT` in `emit-framework.ts`, checked into
 * `@happyvertical/smrt-mobile` as `MobileAuthContract.kt`). Server-side
 * implementations — the reusable SvelteKit handlers in
 * `@happyvertical/smrt-users` (issue #1748) — import them from here so the
 * wire contract has one owning package on both sides.
 *
 * Two sync guarantees keep the three representations locked together:
 *
 * 1. Each interface has a `MobileWireShape` descriptor below. The `satisfies`
 *    check makes the descriptor fail to COMPILE when it disagrees with the
 *    interface (missing/extra field, or wrong required/optional/nullable
 *    kind).
 * 2. `__tests__/framework-auth-types.test.ts` parses the Kotlin literal and
 *    asserts it matches the descriptors field-for-field, so editing either
 *    side without the other fails the contract package's tests.
 *
 * Kotlin → TypeScript field mapping:
 * - `val x: T` (no default)        → `x: T` (required)
 * - `val x: T = <non-null value>`  → `x?: T` (kotlinx.serialization omits
 *   default-equal values by default, and decoders fill absent fields from
 *   defaults — so the wire may omit them in either direction)
 * - `val x: T? = null`             → `x?: T | null`
 *
 * @packageDocumentation
 */

/**
 * Classifies one wire field. Mirrors the three Kotlin declaration forms the
 * framework contract uses (see the mapping table in the module docs).
 */
export type MobileWireFieldKind = 'required' | 'optional' | 'nullable';

/**
 * Compile-time-checked shape descriptor for a wire type: one entry per field,
 * whose kind is DERIVED from the TypeScript declaration. Using
 * `Extract<keyof T, string>` keeps the mapped type non-homomorphic, so every
 * key must be listed (optionality is not copied from `T`) while `T[K]` still
 * carries `undefined` for optional properties.
 */
export type MobileWireShape<T> = {
  [K in Extract<keyof T, string>]: undefined extends T[K]
    ? null extends T[K]
      ? 'nullable'
      : 'optional'
    : 'required';
};

/** Signed-in user summary returned by auth/complete and the session bootstrap. */
export interface MobileUserSummary {
  id: string;
  email?: string;
  label?: string;
}

/** Tenant summary with subscription surface (reserved for app responses). */
export interface MobileTenantSummary {
  id: string;
  name?: string;
  slug?: string;
  planName?: string;
  subscriptionStatus?: string;
}

/** One selectable tenant, labeled with the role the user holds there. */
export interface MobileTenantOption {
  id: string;
  name?: string;
  slug?: string;
  roleSlug?: string;
  roleLabel?: string;
}

/** One configured auth provider (reserved for app-side provider pickers). */
export interface MobileAuthProviderSummary {
  id: string;
  label?: string;
  type?: string;
  supportsPkce?: boolean;
}

/** Body of `POST /api/mobile/auth/start`. */
export interface MobileAuthStartRequest {
  providerId?: string | null;
  redirectUri: string;
  scopes?: string[];
  state?: string | null;
  loginHint?: string | null;
}

/**
 * Response of `POST /api/mobile/auth/start`. The client persists `state` and
 * `codeVerifier` (as an opaque pending handshake) and echoes them back on
 * `auth/complete`; `state` is also validated against the IdP redirect.
 */
export interface MobileAuthStartResponse {
  providerId: string;
  authorizationUrl: string;
  state: string;
  codeVerifier?: string | null;
  nonce?: string | null;
  redirectUri: string;
}

/** Body of `POST /api/mobile/auth/complete`. */
export interface MobileAuthCompleteRequest {
  providerId?: string | null;
  code: string;
  state?: string | null;
  codeVerifier?: string | null;
  redirectUri: string;
}

/**
 * Response of `POST /api/mobile/auth/complete` — the mobile bearer session.
 * `accessToken` goes into `Authorization: Bearer <token>` on every
 * authenticated `/api/mobile` request.
 */
export interface MobileAuthSession {
  accessToken: string;
  tokenType?: string;
  expiresAt?: string;
  user: MobileUserSummary;
  activeTenant?: MobileTenantOption | null;
  tenants?: MobileTenantOption[];
}

/**
 * Response of `GET /api/mobile/session` — the app-boot payload for a stored
 * bearer. `extras` is an app-defined JSON object escape hatch (must remain a
 * JSON object; the Kotlin side decodes it as `JsonObject`).
 */
export interface MobileSessionBootstrap {
  user: MobileUserSummary;
  activeTenant?: MobileTenantOption | null;
  tenants?: MobileTenantOption[];
  extras?: Record<string, unknown> | null;
}

export const MOBILE_USER_SUMMARY_SHAPE = {
  id: 'required',
  email: 'optional',
  label: 'optional',
} as const satisfies MobileWireShape<MobileUserSummary>;

export const MOBILE_TENANT_SUMMARY_SHAPE = {
  id: 'required',
  name: 'optional',
  slug: 'optional',
  planName: 'optional',
  subscriptionStatus: 'optional',
} as const satisfies MobileWireShape<MobileTenantSummary>;

export const MOBILE_TENANT_OPTION_SHAPE = {
  id: 'required',
  name: 'optional',
  slug: 'optional',
  roleSlug: 'optional',
  roleLabel: 'optional',
} as const satisfies MobileWireShape<MobileTenantOption>;

export const MOBILE_AUTH_PROVIDER_SUMMARY_SHAPE = {
  id: 'required',
  label: 'optional',
  type: 'optional',
  supportsPkce: 'optional',
} as const satisfies MobileWireShape<MobileAuthProviderSummary>;

export const MOBILE_AUTH_START_REQUEST_SHAPE = {
  providerId: 'nullable',
  redirectUri: 'required',
  scopes: 'optional',
  state: 'nullable',
  loginHint: 'nullable',
} as const satisfies MobileWireShape<MobileAuthStartRequest>;

export const MOBILE_AUTH_START_RESPONSE_SHAPE = {
  providerId: 'required',
  authorizationUrl: 'required',
  state: 'required',
  codeVerifier: 'nullable',
  nonce: 'nullable',
  redirectUri: 'required',
} as const satisfies MobileWireShape<MobileAuthStartResponse>;

export const MOBILE_AUTH_COMPLETE_REQUEST_SHAPE = {
  providerId: 'nullable',
  code: 'required',
  state: 'nullable',
  codeVerifier: 'nullable',
  redirectUri: 'required',
} as const satisfies MobileWireShape<MobileAuthCompleteRequest>;

export const MOBILE_AUTH_SESSION_SHAPE = {
  accessToken: 'required',
  tokenType: 'optional',
  expiresAt: 'optional',
  user: 'required',
  activeTenant: 'nullable',
  tenants: 'optional',
} as const satisfies MobileWireShape<MobileAuthSession>;

export const MOBILE_SESSION_BOOTSTRAP_SHAPE = {
  user: 'required',
  activeTenant: 'nullable',
  tenants: 'optional',
  extras: 'nullable',
} as const satisfies MobileWireShape<MobileSessionBootstrap>;

/**
 * All auth-contract shape descriptors, keyed by the Kotlin data class name.
 * The parity test asserts this map covers exactly the data classes declared
 * in `MobileAuthContract.kt` — adding a class to either side without the
 * other fails the suite.
 */
export const MOBILE_AUTH_WIRE_SHAPES: Record<
  string,
  Record<string, MobileWireFieldKind>
> = {
  MobileUserSummary: MOBILE_USER_SUMMARY_SHAPE,
  MobileTenantSummary: MOBILE_TENANT_SUMMARY_SHAPE,
  MobileTenantOption: MOBILE_TENANT_OPTION_SHAPE,
  MobileAuthProviderSummary: MOBILE_AUTH_PROVIDER_SUMMARY_SHAPE,
  MobileAuthStartRequest: MOBILE_AUTH_START_REQUEST_SHAPE,
  MobileAuthStartResponse: MOBILE_AUTH_START_RESPONSE_SHAPE,
  MobileAuthCompleteRequest: MOBILE_AUTH_COMPLETE_REQUEST_SHAPE,
  MobileAuthSession: MOBILE_AUTH_SESSION_SHAPE,
  MobileSessionBootstrap: MOBILE_SESSION_BOOTSTRAP_SHAPE,
};
