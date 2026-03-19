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
import { MagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { DEFAULT_TOKEN_EXPIRY_SECONDS } from '../models/MagicLinkToken.js';

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
  private tokenCollection!: MagicLinkTokenCollection;
  private signingKey: Uint8Array | null = null;
  private readonly secret: string;
  private readonly tokenExpiry: number;
  private readonly issuer: string;
  private readonly options: MagicLinkServiceOptions;

  constructor(options: MagicLinkServiceOptions) {
    if (!options.secret) {
      throw new Error('MagicLinkService requires a secret for token signing');
    }
    this.secret = options.secret;
    this.tokenExpiry = options.tokenExpiry ?? DEFAULT_TOKEN_EXPIRY_SECONDS;
    this.issuer = options.issuer ?? 'smrt:magiclink';
    this.options = options;
  }

  /**
   * Initialize collections
   */
  async initialize(): Promise<void> {
    this.tokenCollection = (await (MagicLinkTokenCollection as any).create(
      this.options,
    )) as MagicLinkTokenCollection;
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
  async generate(email: string): Promise<MagicLinkResult> {
    // Dynamic import to avoid eagerly loading jose at module init
    const { SignJWT } = await import('jose');

    const key = await this.getSigningKey();
    const nonce = crypto.randomUUID();
    const normalizedEmail = email.trim().toLowerCase();
    const expiresAt = new Date(Date.now() + this.tokenExpiry * 1000);

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
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${this.tokenExpiry}s`)
      .setIssuer(this.issuer)
      .sign(key);

    return { token, expiresAt };
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

    // Atomically claim the nonce (single-use enforcement).
    // markUsed() checks used=false AND expiresAt > now in a single query,
    // so concurrent verify() calls for the same token will race on the
    // DB write and only one can succeed.
    const claimed = await this.tokenCollection.markUsed(nonce);

    if (!claimed) {
      throw new MagicLinkError('Token has already been used or has expired');
    }

    return { email, nonce };
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
