/**
 * Step-up (recent authentication) check (#4841).
 *
 * A session proves who signed in at some point; a sensitive action (replacing
 * a vault account, for instance) needs proof the person is at the keyboard
 * NOW. The proof is server-side session state: the sign-in time of an
 * interactive session, or the stamp `PasswordCredentialService.stepUp` writes
 * after a fresh password check. This module only decides; it never writes.
 *
 * @packageDocumentation
 */

import type { SessionContext } from './services/SessionService.js';
import { DEFAULT_ROLES } from './types/index.js';

/** The slice of a session context the step-up and owner checks read. */
export type StepUpSession = Pick<
  SessionContext,
  | 'sessionId'
  | 'user'
  | 'reauthenticatedAt'
  | 'membership'
  | 'tenantId'
  | 'authMethod'
  | 'parent'
  | 'permissionCeiling'
  | 'tenantAuthorization'
>;

const OWNER_ROLE_ID: string = DEFAULT_ROLES[0].id;

/** Session channels that are a device, never the person at the keyboard. */
const DEVICE_AUTH_METHODS: ReadonlySet<string> = new Set(['terminal', 'pin']);

/** Stable machine code carried by {@link StepUpRequiredError}. */
export const STEP_UP_REQUIRED_CODE = 'step_up_required';

/** Default age (5 minutes) a step-up may have when an action runs. */
export const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;

/** Largest accepted `maxAgeSeconds` (1 hour). */
export const STEP_UP_MAX_AGE_CEILING_SECONDS = 60 * 60;

/** Clock skew tolerated before a future stamp is treated as forged. */
const FUTURE_SKEW_MS = 30_000;

/**
 * The session has no sufficiently recent authentication. One message and one
 * code for every reason (missing, stale, malformed, wrong session or user), so
 * a caller learns only that it must re-authenticate.
 */
export class StepUpRequiredError extends Error {
  readonly code = STEP_UP_REQUIRED_CODE;

  constructor(message = 'Recent authentication is required.') {
    super(message);
    this.name = 'StepUpRequiredError';
  }
}

export interface RequireRecentAuthenticationOptions {
  /** Longest acceptable age in seconds. Default 300; capped at one hour. */
  maxAgeSeconds?: number;
  /** Clock, injectable for tests. Default `() => new Date()`. */
  now?: () => Date;
  /** The session the caller authenticated; a different session is refused. */
  expectedSessionId?: string;
  /** The user the action is for; a different user's session is refused. */
  expectedUserId?: string;
}

/**
 * Throw {@link StepUpRequiredError} unless `session` (a context from
 * `SessionService.loadSessionContext`) was authenticated within
 * `maxAgeSeconds`. Fails closed: a missing, malformed, future-dated or stale
 * timestamp, a session or user other than the expected ones, or an invalid
 * `maxAgeSeconds` all refuse.
 */
export function requireRecentAuthentication(
  session: Pick<StepUpSession, 'sessionId' | 'user' | 'reauthenticatedAt'>,
  options: RequireRecentAuthenticationOptions = {},
): void {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_STEP_UP_MAX_AGE_SECONDS;
  if (
    !Number.isFinite(maxAge) ||
    maxAge <= 0 ||
    maxAge > STEP_UP_MAX_AGE_CEILING_SECONDS
  ) {
    throw new StepUpRequiredError();
  }
  if (
    options.expectedSessionId !== undefined &&
    session.sessionId !== options.expectedSessionId
  ) {
    throw new StepUpRequiredError();
  }
  if (
    options.expectedUserId !== undefined &&
    session.user?.id !== options.expectedUserId
  ) {
    throw new StepUpRequiredError();
  }
  const at = session.reauthenticatedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new StepUpRequiredError();
  }
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const age = nowMs - at.getTime();
  if (age < -FUTURE_SKEW_MS || age > maxAge * 1000) {
    throw new StepUpRequiredError();
  }
}

/**
 * Whether `session` is a first-class session of the OWNER of its tenant: a
 * direct, active membership in the system `owner` role (not an inherited or
 * ancestor one), with no device or layered channel (`terminal`, `pin`, a
 * parent session) and no permission ceiling. A member, a device-only session
 * and a missing session are all false. Hosts with a custom owner role decide
 * for themselves and pass their own check where this one is injected.
 */
export function isTenantOwnerSession(
  session: StepUpSession | null | undefined,
): boolean {
  if (!session?.user?.id || !session.tenantId) return false;
  const membership = session.membership;
  if (
    !membership ||
    membership.roleId !== OWNER_ROLE_ID ||
    membership.tenantId !== session.tenantId ||
    membership.userId !== session.user.id ||
    (typeof membership.isActive === 'function' && !membership.isActive())
  ) {
    return false;
  }
  if (session.tenantAuthorization?.inheritedFromTenantId) return false;
  if (session.parent || session.permissionCeiling) return false;
  return !(
    typeof session.authMethod === 'string' &&
    DEVICE_AUTH_METHODS.has(session.authMethod)
  );
}
