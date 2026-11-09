/**
 * MagicLinkService - Passwordless email authentication via signed magic link tokens
 *
 * This service handles token generation and verification for magic link
 * authentication. It is framework-agnostic: it returns tokens and verification
 * results, leaving email delivery and cookie management to the caller.
 *
 * Flow:
 * 1. User enters email → generate(email) → token + expiresAt
 * 2. Caller sends email with link containing the token
 * 3. User clicks link → verify(token) → { email, nonce }
 * 4. Caller creates session (via SessionService or createSessionCookie)
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * const magicLink = await MagicLinkService.create({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL },
 *   secret: process.env.AUTH_SECRET,
 * });
 *
 * // Generate a magic link token
 * const { token, expiresAt } = await magicLink.generate('user@example.com');
 *
 * // Verify a magic link token (single-use)
 * const { email, nonce } = await magicLink.verify(token);
 * ```
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { UsersMagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { DEFAULT_TOKEN_EXPIRY_SECONDS } from '../models/MagicLinkToken.js';
import { isValidEmail, normalizeEmail } from '../models/User.js';
import {
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  StepUpRequiredError,
} from '../step-up.js';

/** Token `purpose` claim of a step-up link. Sign-in links carry none. */
const STEP_UP_PURPOSE = 'step_up';

/**
 * Options for MagicLinkService
 */
export interface MagicLinkServiceOptions extends SmrtClassOptions {
  /** Secret used to derive the HMAC signing key (required) */
  secret: string;
  /** Token expiry in seconds (default: 10 minutes) */
  tokenExpiry?: number;
  /** JWT issuer claim (default: 'smrt:magiclink') */
  issuer?: string;
  /**
   * Lifetime of a step-up link in seconds. Default and ceiling: the step-up
   * window (300), and never longer than `tokenExpiry`.
   */
  stepUpTokenExpiry?: number;
}

/** Result of {@link MagicLinkService.requestStepUp}. */
export interface MagicLinkStepUpRequest extends MagicLinkResult {
  /** The address the link must be sent to: the session user's own email. */
  email: string;
}

/** Result of {@link MagicLinkService.consumeStepUp}. */
export interface MagicLinkStepUpResult {
  sessionId: string;
  /** ISO time stamped on the session. */
  reauthenticatedAt: string;
}

/**
 * Result of generating a magic link token
 */
export interface MagicLinkResult {
  /** The signed JWT token */
  token: string;
  /** When the token expires */
  expiresAt: Date;
}

/**
 * Result of verifying a magic link token
 */
export interface MagicLinkVerifyResult {
  /** The email address from the token */
  email: string;
  /** The nonce (for correlation/logging) */
  nonce: string;
  /** Optional signed immutable identity binding supplied by a trusted host. */
  subject?: string;
}

/** A verified signature, with the claims only step-up reads. */
interface MagicLinkProof extends MagicLinkVerifyResult {
  purpose?: string;
  /** sha256 hex of the session id a step-up link is bound to. */
  sessionDigest?: string;
  userId?: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Error class for magic link authentication failures
 */
export class MagicLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MagicLinkError';
  }
}

/**
 * MagicLinkService provides passwordless authentication via email magic links.
 *
 * Tokens are HMAC-signed JWTs with embedded nonces for replay protection.
 * The service is framework-agnostic — it does not send emails or set cookies.
 */
export class MagicLinkService {
  private tokenCollection!: UsersMagicLinkTokenCollection;
  private sessionRows?: SessionCollection;
  private userRows?: UserCollection;
  private signingKey: Uint8Array | null = null;
  private readonly secret: string;
  private readonly tokenExpiry: number;
  private readonly issuer: string;
  private readonly stepUpTokenExpiry: number;
  private readonly options: MagicLinkServiceOptions;

  constructor(options: MagicLinkServiceOptions) {
    if (!options.secret) {
      throw new Error('MagicLinkService requires a secret for token signing');
    }
    this.secret = options.secret;
    this.tokenExpiry = options.tokenExpiry ?? DEFAULT_TOKEN_EXPIRY_SECONDS;
    this.issuer = options.issuer ?? 'smrt:magiclink';
    const stepUpExpiry = options.stepUpTokenExpiry;
    this.stepUpTokenExpiry = Math.min(
      this.tokenExpiry,
      DEFAULT_STEP_UP_MAX_AGE_SECONDS,
      typeof stepUpExpiry === 'number' &&
        Number.isFinite(stepUpExpiry) &&
        stepUpExpiry > 0
        ? stepUpExpiry
        : DEFAULT_STEP_UP_MAX_AGE_SECONDS,
    );
    this.options = options;
  }

  /**
   * Initialize collections
   */
  async initialize(): Promise<void> {
    this.tokenCollection = await UsersMagicLinkTokenCollection.create(
      this.options,
    );
  }

  /** Session and user rows, opened on first step-up use only. */
  private async stepUpRows(): Promise<{
    sessions: SessionCollection;
    users: UserCollection;
  }> {
    this.sessionRows ??= await SessionCollection.create(this.options);
    this.userRows ??= await UserCollection.create(this.options);
    return { sessions: this.sessionRows, users: this.userRows };
  }

  /**
   * Derive the HMAC signing key from the secret
   */
  private async getSigningKey(): Promise<Uint8Array> {
    if (this.signingKey) return this.signingKey;

    const encoder = new TextEncoder();
    const data = encoder.encode(`magiclink:${this.secret}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    this.signingKey = new Uint8Array(hashBuffer);

    return this.signingKey;
  }

  /**
   * Generate a magic link token for the given email.
   *
   * Stores a nonce in the database for replay protection.
   * The caller is responsible for emailing the token to the user.
   */
  async generate(
    email: string,
    options: { subject?: string } = {},
  ): Promise<MagicLinkResult> {
    return this.issue(email, this.tokenExpiry, {
      ...(options.subject !== undefined ? { sub: options.subject } : {}),
    });
  }

  private async issue(
    email: string,
    expirySeconds: number,
    claims: Record<string, unknown>,
  ): Promise<MagicLinkResult> {
    // Dynamic import to avoid eagerly loading jose at module init
    const { SignJWT } = await import('jose');

    const key = await this.getSigningKey();
    const nonce = crypto.randomUUID();
    const normalizedEmail = normalizeEmail(email);

    if (!isValidEmail(normalizedEmail)) {
      throw new MagicLinkError('Invalid email address');
    }

    const expiresAt = new Date(Date.now() + expirySeconds * 1000);

    // Store nonce for replay protection
    await this.tokenCollection.create({
      nonce,
      email: normalizedEmail,
      used: false,
      expiresAt,
    });

    // Sign the token
    const token = await new SignJWT({
      email: normalizedEmail,
      nonce,
      ...claims,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${expirySeconds}s`)
      .setIssuer(this.issuer)
      .sign(key);

    return { token, expiresAt };
  }

  /**
   * Issue a step-up link (#4841) for the authenticated `sessionId`: a
   * short-lived, single-use token with purpose `step_up`, signed to that
   * session (by digest, never the raw id) and its user. For a person who has
   * no password or passkey to re-prove. Send it to the returned `email`, the
   * session user's own address; do not accept an address from the request. A
   * session that cannot step up gets a {@link StepUpRequiredError}. The link
   * cannot sign anyone in: {@link MagicLinkService.verify} and
   * {@link MagicLinkService.inspect} refuse it.
   */
  async requestStepUp(input: {
    sessionId: string;
  }): Promise<MagicLinkStepUpRequest> {
    const sessionId =
      typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!sessionId) throw new StepUpRequiredError();
    const { sessions, users } = await this.stepUpRows();
    const session = await sessions.findValidSession(sessionId);
    if (!session?.isStepUpEligible()) {
      throw new StepUpRequiredError();
    }
    const user = await users.get(session.userId);
    if (!user?.id || !user.isActive() || !isValidEmail(user.email)) {
      throw new StepUpRequiredError();
    }
    const issued = await this.issue(user.email, this.stepUpTokenExpiry, {
      purpose: STEP_UP_PURPOSE,
      sid: await sha256Hex(sessionId),
      uid: user.id,
    });
    return { ...issued, email: normalizeEmail(user.email) };
  }

  /**
   * Consume a step-up link (#4841) presented by the SAME session it was issued
   * to, and stamp `reauthenticatedAt` on that session (the same marking the
   * password step-up uses). No session is minted. The signature, expiry,
   * purpose, session, user and current email are all checked before the
   * single-use nonce is claimed, so a link presented by another session (or
   * for another user) is not burned by it. A sign-in link, an expired or
   * reused link, or any mismatch is one {@link StepUpRequiredError}; which
   * check failed is not revealed.
   */
  async consumeStepUp(input: {
    token: string;
    sessionId: string;
  }): Promise<MagicLinkStepUpResult> {
    const sessionId =
      typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!sessionId || typeof input?.token !== 'string') {
      throw new StepUpRequiredError();
    }
    let proof: MagicLinkProof;
    try {
      proof = await this.verifySignature(input.token);
    } catch {
      throw new StepUpRequiredError();
    }
    if (
      proof.purpose !== STEP_UP_PURPOSE ||
      !proof.userId ||
      proof.sessionDigest !== (await sha256Hex(sessionId))
    ) {
      throw new StepUpRequiredError();
    }
    const { sessions, users } = await this.stepUpRows();
    const session = await sessions.findValidSession(sessionId);
    if (!session?.isStepUpEligible() || session.userId !== proof.userId) {
      throw new StepUpRequiredError();
    }
    const user = await users.get(session.userId);
    if (
      !user?.id ||
      !user.isActive() ||
      normalizeEmail(user.email) !== proof.email
    ) {
      throw new StepUpRequiredError();
    }
    if (!(await this.tokenCollection.markUsed(proof.nonce))) {
      throw new StepUpRequiredError();
    }
    const at = await sessions.markReauthenticated(sessionId, {
      userId: user.id,
    });
    if (!at) throw new StepUpRequiredError();
    return { sessionId, reauthenticatedAt: at.toISOString() };
  }

  /**
   * Verify a magic link token.
   *
   * Checks JWT signature, expiry, and that the nonce hasn't been used.
   * Marks the nonce as used on success (single-use enforcement).
   *
   * @throws {MagicLinkError} If the token is invalid, expired, or already used
   */
  async verify(token: string): Promise<MagicLinkVerifyResult> {
    const proof = this.signInProof(await this.verifySignature(token));
    if (!(await this.tokenCollection.markUsed(proof.nonce)))
      throw new MagicLinkError('Token has already been used or has expired');
    return proof;
  }

  /**
   * Validate a signed live nonce without consuming it. This is preparation only,
   * never authentication: a final verify() must atomically claim the token.
   */
  async inspect(token: string): Promise<MagicLinkVerifyResult> {
    const proof = this.signInProof(await this.verifySignature(token));
    if (!(await this.tokenCollection.isAvailable(proof.nonce, proof.email)))
      throw new MagicLinkError('Token has already been used or has expired');
    return proof;
  }

  /**
   * A sign-in proof: refuses any token with a `purpose` (a step-up link) and
   * strips the step-up claims, so a step-up link can never sign anyone in.
   * The token is not consumed.
   */
  private signInProof(proof: MagicLinkProof): MagicLinkVerifyResult {
    if (proof.purpose !== undefined) throw new MagicLinkError('Invalid token');
    return {
      email: proof.email,
      nonce: proof.nonce,
      ...(proof.subject !== undefined ? { subject: proof.subject } : {}),
    };
  }

  private async verifySignature(token: string): Promise<MagicLinkProof> {
    const { jwtVerify, errors } = await import('jose');

    const key = await this.getSigningKey();

    // Verify JWT signature and expiry
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, key, {
        issuer: this.issuer,
      });
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      if (err instanceof errors.JWTExpired) {
        throw new MagicLinkError('Token has expired');
      }
      throw new MagicLinkError('Invalid token');
    }

    const email = payload.email;
    const nonce = payload.nonce;

    // Explicit type validation — JWT payload values are unknown
    if (typeof email !== 'string' || typeof nonce !== 'string') {
      throw new MagicLinkError('Invalid token payload');
    }

    return {
      email: normalizeEmail(email),
      nonce,
      ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
      ...(payload.purpose !== undefined
        ? {
            purpose: typeof payload.purpose === 'string' ? payload.purpose : '',
          }
        : {}),
      ...(typeof payload.sid === 'string'
        ? { sessionDigest: payload.sid }
        : {}),
      ...(typeof payload.uid === 'string' ? { userId: payload.uid } : {}),
    };
  }

  /**
   * Clean up expired tokens (run periodically)
   */
  async cleanupExpiredTokens(): Promise<number> {
    return this.tokenCollection.deleteExpired();
  }

  /**
   * Static factory method
   */
  static async create(
    options: MagicLinkServiceOptions,
  ): Promise<MagicLinkService> {
    const service = new MagicLinkService(options);
    await service.initialize();
    return service;
  }
}
