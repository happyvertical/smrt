/**
 * TerminalAuthService — device-code grant for terminal/CLI logins.
 *
 * Flow:
 * 1. CLI calls `createRequest(origin)` → user code (short, displayed) + device
 *    code (long, kept secret) + verification URL.
 * 2. User opens the verification URL in a browser, signs in normally, and
 *    POSTs the user code via `approveRequest({ user, tenantId, userCode })`.
 * 3. CLI polls `exchangeDeviceCode(deviceCode)`; once approved, gets back the
 *    bearer session id (an opaque token usable as `Authorization: Bearer …`).
 * 4. Server-side request handlers resolve incoming bearer tokens via
 *    `loadBearerSession(token)`, and revoke them via `destroyBearerSession`.
 *
 * The service is framework-agnostic: it does not set cookies, parse Request
 * objects, or render pages. SvelteKit glue lives in the package's
 * `./sveltekit` subpath.
 *
 * @packageDocumentation
 */

import { createHash, randomBytes } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import type {
  CliAuthRequestStatus,
  UsersCliAuthRequest,
} from '../models/CliAuthRequest.js';
import type { User } from '../models/User.js';
import { type SessionContext, SessionService } from './SessionService.js';

/** Default polling interval the CLI should honour while waiting for approval. */
export const DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS = 2;
/** Default lifetime of a pending request (10 minutes). */
export const DEFAULT_CLI_AUTH_REQUEST_TTL_SECONDS = 10 * 60;
/** Default lifetime of the session minted on approval (30 days). */
export const DEFAULT_CLI_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Default cap on consecutive failed approve attempts per user before lockout. */
export const DEFAULT_CLI_AUTH_MAX_APPROVE_ATTEMPTS = 5;
/** Default sliding window for counting failed approve attempts (5 minutes). */
export const DEFAULT_CLI_AUTH_APPROVE_ATTEMPT_WINDOW_SECONDS = 5 * 60;

/**
 * Options for {@link TerminalAuthService}.
 */
export interface TerminalAuthServiceOptions extends SmrtClassOptions {
  /**
   * Cookie name passed through to {@link SessionService}. Should match the
   * site's normal session cookie name so the same SessionService can
   * resolve both browser cookies and CLI bearer tokens.
   */
  sessionCookieName?: string;
  /**
   * Prefix prepended to randomly generated user codes — purely for human
   * recognition ("WG-1A2B3C4D"). Defaults to no prefix.
   */
  userCodePrefix?: string;
  /** TTL of a pending request, in seconds. */
  requestTtlSeconds?: number;
  /** TTL of the session minted on approval, in seconds. */
  sessionTtlSeconds?: number;
  /** Polling interval hint returned to clients. */
  pollIntervalSeconds?: number;
  /**
   * Path on the site's origin where the approval page is mounted. Used to
   * build the verification URL returned to the CLI. Defaults to
   * `/terminal-login`.
   */
  verificationPath?: string;
  /** Whether the underlying SessionService should auto-extend on access. */
  sessionAutoExtend?: boolean;
  /**
   * Maximum consecutive failed approve attempts allowed per user inside the
   * sliding window before the user is locked out from approving any further
   * codes. Defaults to {@link DEFAULT_CLI_AUTH_MAX_APPROVE_ATTEMPTS}.
   *
   * User codes are only 32 bits of entropy; without this throttle, an
   * authenticated attacker could brute-force pending codes and hijack
   * another user's CLI session by approving it themselves.
   */
  maxApproveAttempts?: number;
  /**
   * Sliding window (seconds) over which {@link maxApproveAttempts} counts.
   * Defaults to {@link DEFAULT_CLI_AUTH_APPROVE_ATTEMPT_WINDOW_SECONDS}.
   */
  approveAttemptWindowSeconds?: number;
}

/**
 * What `createRequest` returns to the CLI.
 */
export interface CliAuthStartResult {
  deviceCode: string;
  expiresAt: string;
  interval: number;
  userCode: string;
  verificationUrl: string;
}

/**
 * What `exchangeDeviceCode` returns to the polling CLI.
 */
export type CliAuthTokenResult =
  | { status: 'pending'; expiresAt: string; interval: number }
  | { status: 'expired' }
  | {
      status: 'approved';
      accessToken: string;
      expiresIn: number;
      tokenType: 'Bearer';
    };

/**
 * Inputs for `approveRequest`. The caller is responsible for authenticating
 * the user via its existing browser session before calling this.
 */
export interface ApproveCliAuthRequestInput {
  userCode: string;
  user: Pick<User, 'id' | 'email'>;
  tenantId: string | null | undefined;
  ipAddress?: string;
  userAgent?: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function hashDeviceCode(deviceCode: string): string {
  return createHash('sha256').update(deviceCode).digest('hex');
}

function isExpired(request: UsersCliAuthRequest): boolean {
  return new Date(request.expiresAt).getTime() <= Date.now();
}

/**
 * High-level orchestration of the terminal device-code flow.
 */
export class TerminalAuthService {
  private readonly options: TerminalAuthServiceOptions;
  private readonly userCodePrefix: string;
  private readonly requestTtlSeconds: number;
  private readonly sessionTtlSeconds: number;
  private readonly pollIntervalSeconds: number;
  private readonly verificationPath: string;
  private readonly maxApproveAttempts: number;
  private readonly approveAttemptWindowMs: number;
  private readonly failedApprovesByUser = new Map<
    string,
    { count: number; firstAttemptAt: number }
  >();
  private requestCollection!: UsersCliAuthRequestCollection;
  private sessionService!: SessionService;

  constructor(options: TerminalAuthServiceOptions) {
    this.options = options;
    // Lookups uppercase the submitted code before querying, so the stored
    // form must also be uppercase — normalize once here so consumers can
    // pass any case.
    this.userCodePrefix = (options.userCodePrefix ?? '').trim().toUpperCase();
    this.requestTtlSeconds =
      options.requestTtlSeconds ?? DEFAULT_CLI_AUTH_REQUEST_TTL_SECONDS;
    this.sessionTtlSeconds =
      options.sessionTtlSeconds ?? DEFAULT_CLI_SESSION_TTL_SECONDS;
    this.pollIntervalSeconds =
      options.pollIntervalSeconds ?? DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS;
    this.maxApproveAttempts =
      options.maxApproveAttempts ?? DEFAULT_CLI_AUTH_MAX_APPROVE_ATTEMPTS;
    this.approveAttemptWindowMs =
      (options.approveAttemptWindowSeconds ??
        DEFAULT_CLI_AUTH_APPROVE_ATTEMPT_WINDOW_SECONDS) * 1000;
    const verificationPath = options.verificationPath ?? '/terminal-login';
    this.verificationPath = verificationPath.startsWith('/')
      ? verificationPath
      : `/${verificationPath}`;
  }

  async initialize(): Promise<void> {
    this.requestCollection = (await (
      UsersCliAuthRequestCollection as any
    ).create(this.options)) as UsersCliAuthRequestCollection;
    this.sessionService = await SessionService.create({
      ...this.options,
      autoExtend: this.options.sessionAutoExtend ?? true,
      cookieName: this.options.sessionCookieName,
      defaultTTL: this.sessionTtlSeconds,
    });
  }

  static async create(
    options: TerminalAuthServiceOptions,
  ): Promise<TerminalAuthService> {
    const service = new TerminalAuthService(options);
    await service.initialize();
    return service;
  }

  private makeUserCode(): string {
    const raw = randomBytes(6).toString('hex').toUpperCase().slice(0, 8);
    return this.userCodePrefix ? `${this.userCodePrefix}-${raw}` : raw;
  }

  /**
   * Generate a user code that is not currently in use by another *active*
   * (pending or approved-but-unclaimed) request. Collisions are vanishingly
   * rare (1 in 2^32 per attempt) but happen at scale; retrying keeps the
   * affected CLI from being locked out.
   */
  private async makeUniqueUserCode(maxAttempts = 5): Promise<string> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = this.makeUserCode();
      const existing = await this.requestCollection.findByUserCode(candidate);
      if (!existing || existing.status === 'expired') {
        return candidate;
      }
    }
    throw new TerminalAuthError(
      'Unable to generate a unique terminal user code; try again.',
    );
  }

  /**
   * Start a new request. Returns the device code the CLI keeps secret, the
   * user code the human types into the browser, and the verification URL to
   * open. The device code is stored only as a hash.
   */
  async createRequest(origin: string): Promise<CliAuthStartResult> {
    const trimmedOrigin = origin.replace(/\/+$/u, '');
    const deviceCode = base64url(randomBytes(32));
    const userCode = await this.makeUniqueUserCode();
    const expiresAt = new Date(Date.now() + this.requestTtlSeconds * 1000);

    const request = await this.requestCollection.create({
      deviceCodeHash: hashDeviceCode(deviceCode),
      expiresAt,
      status: 'pending',
      userCode,
    });
    await request.save();

    return {
      deviceCode,
      expiresAt: expiresAt.toISOString(),
      interval: this.pollIntervalSeconds,
      userCode,
      verificationUrl: `${trimmedOrigin}${this.verificationPath}?code=${encodeURIComponent(userCode)}`,
    };
  }

  /**
   * Look up a request by user code. Performs lazy expiry: pending requests
   * past their TTL are flipped to `expired` and persisted.
   */
  async getRequestForUserCode(
    userCode: string,
  ): Promise<UsersCliAuthRequest | null> {
    const request = await this.requestCollection.findByUserCode(userCode);
    if (!request) return null;

    if (request.status === 'pending' && isExpired(request)) {
      request.status = 'expired';
      await request.save();
    }
    return request;
  }

  /**
   * Mark a pending request as approved and mint a bearer session bound to the
   * approving user. Idempotent: re-approving an already-approved request is a
   * no-op. Throws if the user/tenant are missing, the request is unknown, or
   * the request has expired.
   */
  async approveRequest(
    input: ApproveCliAuthRequestInput,
  ): Promise<UsersCliAuthRequest> {
    if (!input.user.id || !input.tenantId) {
      throw new TerminalAuthError(
        'An authenticated tenant session is required.',
      );
    }

    this.assertApproveRateLimit(input.user.id);

    const request = await this.getRequestForUserCode(input.userCode);
    if (!request) {
      this.recordFailedApprove(input.user.id);
      throw new TerminalAuthError('Terminal login request not found.');
    }
    if (request.status === 'approved') {
      // Idempotent success — don't penalize a re-approval.
      return request;
    }
    if (request.status !== 'pending' || isExpired(request)) {
      request.status = 'expired';
      await request.save();
      this.recordFailedApprove(input.user.id);
      throw new TerminalAuthError('Terminal login request has expired.');
    }

    const sessionId = await this.sessionService.createSession(
      input.user.id,
      input.tenantId,
      {
        data: {
          approvedBy: input.user.email ?? input.user.id,
          kind: 'terminal',
        },
        ipAddress: input.ipAddress,
        ttl: this.sessionTtlSeconds,
        userAgent: input.userAgent,
      },
    );

    request.approvedAt = new Date();
    request.sessionId = sessionId;
    request.status = 'approved';
    request.tenantId = input.tenantId;
    request.userId = input.user.id;
    await request.save();
    this.failedApprovesByUser.delete(input.user.id);
    return request;
  }

  /**
   * Throw {@link TerminalAuthRateLimitError} if the user has exceeded the
   * configured failed-approve budget inside the current sliding window.
   */
  private assertApproveRateLimit(userId: string): void {
    const tracking = this.failedApprovesByUser.get(userId);
    if (!tracking) return;

    const elapsedMs = Date.now() - tracking.firstAttemptAt;
    if (elapsedMs >= this.approveAttemptWindowMs) {
      this.failedApprovesByUser.delete(userId);
      return;
    }

    if (tracking.count >= this.maxApproveAttempts) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((this.approveAttemptWindowMs - elapsedMs) / 1000),
      );
      throw new TerminalAuthRateLimitError(
        'Too many failed terminal-login attempts. Try again later.',
        retryAfterSeconds,
      );
    }
  }

  /** Increment the failed-approve counter for `userId`, starting the window if needed. */
  private recordFailedApprove(userId: string): void {
    const tracking = this.failedApprovesByUser.get(userId);
    if (!tracking) {
      this.failedApprovesByUser.set(userId, {
        count: 1,
        firstAttemptAt: Date.now(),
      });
      return;
    }
    tracking.count += 1;
  }

  /**
   * Exchange a device code (the secret the CLI keeps) for an access token
   * once the request has been approved. Returns `{ status: 'pending' }` while
   * the CLI should keep polling, and `{ status: 'expired' }` if the request
   * was never approved within its TTL.
   */
  async exchangeDeviceCode(deviceCode: string): Promise<CliAuthTokenResult> {
    const request = await this.requestCollection.findByDeviceCodeHash(
      hashDeviceCode(deviceCode),
    );
    if (!request) {
      return { status: 'expired' };
    }

    // Approved requests stay claimable even after the original request TTL —
    // the session has its own (longer) lifetime, and the CLI may poll just
    // after approval but after `expiresAt`. Check this before TTL expiry so
    // freshly minted sessions don't get orphaned.
    if (request.status === 'approved' && request.sessionId) {
      return {
        accessToken: request.sessionId,
        expiresIn: this.sessionTtlSeconds,
        status: 'approved',
        tokenType: 'Bearer',
      };
    }

    if (isExpired(request)) {
      if (request.status === 'pending') {
        request.status = 'expired';
        await request.save();
      }
      return { status: 'expired' };
    }

    if (request.status === 'pending') {
      return {
        expiresAt: new Date(request.expiresAt).toISOString(),
        interval: this.pollIntervalSeconds,
        status: 'pending',
      };
    }

    return { status: 'expired' };
  }

  /**
   * Resolve a bearer token issued by this service into a full session
   * context — load the user, permissions, and tenant just like the cookie
   * path does. Returns `null` if the token is unknown, expired, or revoked.
   */
  async loadBearerSession(token: string): Promise<SessionContext | null> {
    return this.sessionService.loadSessionContext(token);
  }

  /**
   * Revoke a bearer token (CLI logout). Returns true if a session was
   * actually revoked.
   */
  async destroyBearerSession(token: string): Promise<boolean> {
    return this.sessionService.destroySession(token);
  }

  /**
   * Delete expired pending requests (cleanup job).
   */
  async cleanupExpiredRequests(): Promise<number> {
    return this.requestCollection.deleteExpired();
  }

  /** The default polling interval clients should use. Exposed for tests. */
  get pollInterval(): number {
    return this.pollIntervalSeconds;
  }
}

/**
 * Error class for terminal auth failures the caller is expected to surface to
 * the user (vs. unexpected internal errors).
 */
export class TerminalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalAuthError';
  }
}

/**
 * Thrown when a user has exceeded the configured failed-approve budget. The
 * caller (SvelteKit handler, REST adapter, etc.) is expected to surface this
 * as HTTP 429 with `Retry-After: retryAfterSeconds`.
 */
export class TerminalAuthRateLimitError extends TerminalAuthError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'TerminalAuthRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type { CliAuthRequestStatus };
