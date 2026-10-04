/**
 * LoginAttemptLimiter — shared rate limiting and lockout for every
 * credential-based sign-in (#3273).
 *
 * ## Contract
 *
 * ```ts
 * const lease = await limiter.reserve({ kind: 'password', subject: emailKey, source: ip });
 * if (!lease.allowed) throw new LoginRateLimitError(lease.retryAfterSeconds);
 * try {
 *   const ok = await verifyCredential(...);   // ALWAYS runs — see below
 *   if (!ok) { await lease.fail(); throw new InvalidCredentialsError(); }
 *   await lease.succeed();
 * } catch (error) {
 *   if (!(error instanceof InvalidCredentialsError)) await lease.release();
 *   throw error;
 * }
 * ```
 *
 * Two budgets are drawn from independently: the **subject** (the identifier
 * the client submitted — an email key or user id, never a resolved account)
 * and the **source** (client IP, or the device/station the attempt came
 * from). Either one being exhausted refuses the attempt. Both are stored as
 * hashes.
 *
 * ## Non-enumeration
 *
 * The limiter itself cannot tell a known subject from an unknown one: the
 * key is whatever the client typed. Consumers keep that property by running
 * the same credential work for a missing account as for a wrong credential
 * (compare against a precomputed dummy hash) and by surfacing one error for
 * "unknown", "wrong", and "nothing enrolled". A 429 does reveal that *some*
 * client has been hammering that identifier, which is standard and accepted;
 * it must never reveal whether the identifier maps to an account.
 *
 * ## Backoff
 *
 * Inside a window a key gets `maxAttempts` reservations. The failure that
 * exhausts the budget locks the key for `base × factor^n` seconds (capped),
 * where `n` counts consecutive exhausted budgets with no success in between.
 * A success resets the streak; so does leaving the key idle.
 *
 * ## Audit
 *
 * Every decision is reported to a {@link LoginAuditSink}. The default sink
 * persists {@link UsersLoginAuditEvent} rows; pass `audit: false` to disable
 * or supply a sink that forwards to the host's own log.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { UsersLoginAttemptCollection } from '../collections/LoginAttemptCollection.js';
import { UsersLoginAuditEventCollection } from '../collections/LoginAuditEventCollection.js';
import type { LoginAttemptScope } from '../models/LoginAttempt.js';
import type { LoginAuditOutcome } from '../models/LoginAuditEvent.js';

/** Default reservations per key per window. */
export const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
/** Default sliding window (5 minutes). */
export const DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS = 5 * 60;
/** Default first lockout (1 minute). */
export const DEFAULT_LOGIN_LOCKOUT_BASE_SECONDS = 60;
/** Default lockout multiplier per consecutive exhausted budget. */
export const DEFAULT_LOGIN_LOCKOUT_FACTOR = 2;
/** Default lockout ceiling (1 hour). */
export const DEFAULT_LOGIN_LOCKOUT_MAX_SECONDS = 60 * 60;

export interface LoginLockoutOptions {
  baseSeconds?: number;
  factor?: number;
  maxSeconds?: number;
}

/** One auditable decision. Keys are already hashed; nothing here is raw. */
export interface LoginAuditEntry {
  kind: string;
  outcome: LoginAuditOutcome;
  subjectKeyHash: string | null;
  sourceKeyHash: string | null;
  retryAfterSeconds?: number;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

/** Where sign-in decisions are reported. Must not throw into the sign-in path. */
export interface LoginAuditSink {
  record(entry: LoginAuditEntry): Promise<void>;
}

export interface LoginAttemptLimiterOptions extends SmrtClassOptions {
  /** Reservations per key per window. Defaults to {@link DEFAULT_LOGIN_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Sliding window in seconds. Defaults to {@link DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS}. */
  windowSeconds?: number;
  /**
   * Exponential lockout once a window's budget is exhausted. `false`
   * disables lockout and keeps only the fixed window (the pre-#3273
   * terminal-approve behaviour).
   */
  lockout?: LoginLockoutOptions | false;
  /**
   * Idle time after which a key's failure streak is forgiven. Defaults to
   * twice the larger of the window and the lockout ceiling.
   */
  streakResetSeconds?: number;
  /**
   * Audit destination. Omit for the durable default; `false` records nothing.
   */
  audit?: LoginAuditSink | false;
  /**
   * Optional secret mixed into key hashes so a leaked limiter table cannot be
   * joined against a list of known emails or IPs by brute force.
   */
  keyPepper?: string;
}

export interface ReserveLoginAttemptOptions {
  /** Credential kind, for audit only. Keys are shared across kinds on purpose. */
  kind: string;
  /** Identifier the client submitted (email key, user id, tag hash). */
  subject?: string | null;
  /** Client IP, or device/station id. */
  source?: string | null;
  /** Extra audit metadata. Never credentials, session ids, or the subject itself. */
  metadata?: Record<string, unknown>;
}

/** A granted reservation. Exactly one of the three methods must be awaited. */
export interface LoginAttemptLease {
  readonly allowed: true;
  readonly subjectKeyHash: string | null;
  readonly sourceKeyHash: string | null;
  /** The credential was wrong. Keeps the reservation; may lock the key. */
  fail(metadata?: Record<string, unknown>): Promise<LoginFailureOutcome>;
  /** The credential was right. Releases the reservation, resets the streak. */
  succeed(metadata?: Record<string, unknown>): Promise<void>;
  /** Credential work did not run or did not finish. Releases the reservation. */
  release(): Promise<void>;
}

export interface LoginFailureOutcome {
  /** True when this failure locked one of the keys out. */
  lockedOut: boolean;
  /** Seconds the client should wait when `lockedOut`. */
  retryAfterSeconds: number | null;
}

export interface LoginAttemptDenied {
  readonly allowed: false;
  readonly retryAfterSeconds: number;
  /** True when a lockout (not just a full window) refused the attempt. */
  readonly lockedOut: boolean;
  /** Which budget refused the attempt. */
  readonly scope: LoginAttemptScope;
}

export type LoginAttemptDecision = LoginAttemptLease | LoginAttemptDenied;

/**
 * Thrown by consumers when a reservation is refused. Surface as HTTP 429
 * with `Retry-After: retryAfterSeconds`.
 */
export class LoginRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly lockedOut: boolean;

  constructor(
    decision: Pick<LoginAttemptDenied, 'retryAfterSeconds' | 'lockedOut'>,
  ) {
    super('Too many sign-in attempts. Try again later.');
    this.name = 'LoginRateLimitError';
    this.retryAfterSeconds = decision.retryAfterSeconds;
    this.lockedOut = decision.lockedOut;
  }
}

/**
 * Thrown by consumers for every credential failure — unknown subject, wrong
 * credential, nothing enrolled — so responses cannot enumerate accounts.
 */
export class InvalidCredentialsError extends Error {
  constructor(message = 'Invalid credentials.') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

/** Default sink: persist every decision as a {@link UsersLoginAuditEvent}. */
export class DurableLoginAuditSink implements LoginAuditSink {
  private constructor(
    private readonly events: UsersLoginAuditEventCollection,
  ) {}

  static async create(
    options: SmrtClassOptions,
  ): Promise<DurableLoginAuditSink> {
    return new DurableLoginAuditSink(
      await UsersLoginAuditEventCollection.create(options),
    );
  }

  async record(entry: LoginAuditEntry): Promise<void> {
    const event = await this.events.create({
      kind: entry.kind,
      outcome: entry.outcome,
      subjectKeyHash: entry.subjectKeyHash,
      sourceKeyHash: entry.sourceKeyHash,
      retryAfterSeconds: entry.retryAfterSeconds ?? null,
      occurredAt: entry.occurredAt,
    });
    event.setMetadata(entry.metadata ?? {});
    await event.save();
  }
}

interface ReservedKey {
  hash: string;
  scope: LoginAttemptScope;
  windowStartedAt: string;
}

function normalizeKey(scope: LoginAttemptScope, raw: string): string {
  const trimmed = raw.trim();
  return scope === 'subject' ? trimmed.toLowerCase() : trimmed;
}

export class LoginAttemptLimiter {
  private readonly options: LoginAttemptLimiterOptions;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockout: Required<LoginLockoutOptions> | null;
  private readonly streakResetMs: number;
  private attempts!: UsersLoginAttemptCollection;
  private audit: LoginAuditSink | null = null;

  constructor(options: LoginAttemptLimiterOptions) {
    this.options = options;
    this.maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? DEFAULT_LOGIN_MAX_ATTEMPTS),
    );
    this.windowMs =
      (options.windowSeconds ?? DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS) * 1000;
    this.lockout =
      options.lockout === false
        ? null
        : {
            baseSeconds:
              options.lockout?.baseSeconds ??
              DEFAULT_LOGIN_LOCKOUT_BASE_SECONDS,
            factor: options.lockout?.factor ?? DEFAULT_LOGIN_LOCKOUT_FACTOR,
            maxSeconds:
              options.lockout?.maxSeconds ?? DEFAULT_LOGIN_LOCKOUT_MAX_SECONDS,
          };
    const lockoutCeilingMs = (this.lockout?.maxSeconds ?? 0) * 1000;
    this.streakResetMs =
      options.streakResetSeconds !== undefined
        ? options.streakResetSeconds * 1000
        : Math.max(this.windowMs, lockoutCeilingMs) * 2;
  }

  static async create(
    options: LoginAttemptLimiterOptions,
  ): Promise<LoginAttemptLimiter> {
    const limiter = new LoginAttemptLimiter(options);
    await limiter.initialize();
    return limiter;
  }

  async initialize(): Promise<void> {
    this.attempts = await UsersLoginAttemptCollection.create(this.options);
    if (this.options.audit === false) {
      this.audit = null;
    } else if (this.options.audit) {
      this.audit = this.options.audit;
    } else {
      this.audit = await DurableLoginAuditSink.create(this.options);
    }
  }

  /** Stable, peppered hash for a key. Exposed so hosts can correlate audit rows. */
  hashKey(scope: LoginAttemptScope, raw: string): string {
    return createHash('sha256')
      .update(
        `${this.options.keyPepper ?? ''}\u0000${scope}:${normalizeKey(scope, raw)}`,
      )
      .digest('hex');
  }

  /** Lockout length for the n-th consecutive exhausted budget (0-based). */
  lockoutMsFor(exhaustedBudgets: number): number {
    if (!this.lockout) return 0;
    const seconds = Math.min(
      this.lockout.maxSeconds,
      this.lockout.baseSeconds * this.lockout.factor ** exhaustedBudgets,
    );
    return Math.max(0, Math.floor(seconds * 1000));
  }

  /**
   * Reserve one attempt against every key supplied. Subject is reserved
   * first; if the source then refuses, the subject reservation is handed
   * back so one noisy source cannot burn every account's budget.
   */
  async reserve(
    input: ReserveLoginAttemptOptions,
  ): Promise<LoginAttemptDecision> {
    const subjectHash =
      input.subject != null && input.subject.trim() !== ''
        ? this.hashKey('subject', input.subject)
        : null;
    const sourceHash =
      input.source != null && input.source.trim() !== ''
        ? this.hashKey('source', input.source)
        : null;
    if (!subjectHash && !sourceHash) {
      // Fail closed: a limiter call that limits nothing is a caller bug (a
      // verifier whose subjectKey() returned ''), not an unlimited lease.
      throw new Error(
        'LoginAttemptLimiter.reserve() needs a subject or a source key.',
      );
    }
    const reserved: ReservedKey[] = [];
    const audit = (
      outcome: LoginAuditOutcome,
      extra: Partial<LoginAuditEntry> = {},
    ) =>
      this.report({
        kind: input.kind,
        outcome,
        subjectKeyHash: subjectHash,
        sourceKeyHash: sourceHash,
        occurredAt: new Date(),
        metadata: input.metadata,
        ...extra,
      });

    for (const [scope, hash] of [
      ['subject', subjectHash],
      ['source', sourceHash],
    ] as const) {
      if (!hash) continue;
      const reservation = await this.attempts.reserveAttempt({
        limiterKey: hash,
        scope,
        maxAttempts: this.maxAttempts,
        windowMs: this.windowMs,
        streakResetMs: this.streakResetMs,
      });
      if (reservation.allowed) {
        reserved.push({
          hash,
          scope,
          windowStartedAt: reservation.windowStartedAt,
        });
        continue;
      }
      await this.releaseAll(reserved, false);
      await audit('denied', {
        retryAfterSeconds: reservation.retryAfterSeconds,
        metadata: {
          ...input.metadata,
          scope,
          lockedOut: reservation.lockedOut,
        },
      });
      return {
        allowed: false,
        lockedOut: reservation.lockedOut,
        retryAfterSeconds: reservation.retryAfterSeconds,
        scope,
      };
    }

    let settled = false;
    const settle = () => {
      if (settled) throw new Error('Login attempt lease already settled.');
      settled = true;
    };

    return {
      allowed: true,
      subjectKeyHash: subjectHash,
      sourceKeyHash: sourceHash,
      fail: async (metadata) => {
        settle();
        let lockedOut = false;
        let retryAfterSeconds: number | null = null;
        for (const key of reserved) {
          const outcome = await this.attempts.recordFailure({
            limiterKey: key.hash,
            windowStartedAt: key.windowStartedAt,
            maxAttempts: this.maxAttempts,
            lockoutMsFor: (n) => this.lockoutMsFor(n),
          });
          if (outcome.lockedUntil) {
            lockedOut = true;
            const seconds = Math.max(
              1,
              Math.ceil((Date.parse(outcome.lockedUntil) - Date.now()) / 1000),
            );
            retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, seconds);
          }
        }
        await audit(lockedOut ? 'locked' : 'failed', {
          retryAfterSeconds: retryAfterSeconds ?? undefined,
          metadata: { ...input.metadata, ...metadata },
        });
        return { lockedOut, retryAfterSeconds };
      },
      succeed: async (metadata) => {
        settle();
        await this.releaseAll(reserved, true);
        await audit('succeeded', {
          metadata: { ...input.metadata, ...metadata },
        });
      },
      release: async () => {
        settle();
        await this.releaseAll(reserved, false);
      },
    };
  }

  /** Report an administrative credential event through the same sink. */
  async recordManagement(input: {
    kind: string;
    subject?: string | null;
    source?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.report({
      kind: input.kind,
      outcome: 'managed',
      subjectKeyHash: input.subject
        ? this.hashKey('subject', input.subject)
        : null,
      sourceKeyHash: input.source ? this.hashKey('source', input.source) : null,
      occurredAt: new Date(),
      metadata: input.metadata,
    });
  }

  /** Prune idle limiter rows (retention sweep). */
  async cleanupIdle(options: { dryRun?: boolean } = {}): Promise<number> {
    return this.attempts.deleteIdle(this.streakResetMs, options);
  }

  private async releaseAll(
    keys: ReservedKey[],
    resetStreak: boolean,
  ): Promise<void> {
    for (const key of keys) {
      try {
        await this.attempts.releaseAttempt(key.hash, key.windowStartedAt, {
          resetStreak,
        });
      } catch {
        // Reservations are fail-closed and expire with their window. A
        // cleanup outage must never turn a committed sign-in into an
        // apparent failure; retaining the reservation is the safe fallback.
      }
    }
  }

  private async report(entry: LoginAuditEntry): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record(entry);
    } catch {
      // The audit sink is observability, not authorization. A failing sink
      // must not block or alter the sign-in decision already made.
    }
  }
}
