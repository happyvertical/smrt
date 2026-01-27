/**
 * OAuth State Model
 *
 * Manages temporary OAuth state for connecting social accounts.
 * Used to verify callback requests and prevent CSRF attacks.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { SocialPlatformType } from './social-account.js';

/**
 * OAuth state creation options
 */
export interface OAuthStateOptions extends SmrtObjectOptions {
  /**
   * Platform being connected
   */
  platform?: SocialPlatformType;

  /**
   * CSRF state token
   */
  state?: string;

  /**
   * PKCE code verifier (for platforms that require it)
   */
  codeVerifier?: string | null;

  /**
   * Redirect URI used in the OAuth request
   */
  redirectUri?: string;

  /**
   * Requested OAuth scopes
   */
  scopes?: string[];

  /**
   * When this state expires
   */
  expiresAt?: Date;

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Temporary OAuth state for social account connection
 *
 * OAuthState stores temporary data during the OAuth flow to:
 * - Verify callback requests match initiated requests (CSRF protection)
 * - Store PKCE code verifier for code exchange
 * - Track redirect URI and scopes for verification
 *
 * These records should be cleaned up after successful connection
 * or after expiration.
 *
 * @example
 * ```typescript
 * import { OAuthState } from '@happyvertical/smrt-social';
 *
 * // Create state when initiating OAuth
 * const state = new OAuthState({
 *   platform: 'youtube',
 *   state: crypto.randomUUID(),
 *   codeVerifier: generatePKCEVerifier(),
 *   redirectUri: 'https://app.example.com/oauth/callback',
 *   scopes: ['youtube.upload', 'youtube.readonly'],
 *   expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
 * });
 * await state.save();
 *
 * // After successful callback, delete the state
 * await state.delete();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'delete'],
  },
  mcp: false,
  cli: true,
})
export class OAuthState extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Platform being connected
   */
  platform: SocialPlatformType = 'youtube';

  /**
   * CSRF state token
   * This is sent to the OAuth provider and verified on callback
   */
  state: string = '';

  /**
   * PKCE code verifier
   * Required for platforms using PKCE (YouTube, etc.)
   */
  codeVerifier: string | null = null;

  /**
   * Redirect URI used in the OAuth request
   * Must match on callback for verification
   */
  redirectUri: string = '';

  /**
   * Requested OAuth scopes
   */
  scopes: string[] = [];

  /**
   * When this state expires
   * States should be short-lived (10 minutes typical)
   */
  expiresAt: Date = new Date(Date.now() + 10 * 60 * 1000);

  constructor(options: OAuthStateOptions = {}) {
    super(options);

    if (options.platform !== undefined) this.platform = options.platform;
    if (options.state !== undefined) this.state = options.state;
    if (options.codeVerifier !== undefined)
      this.codeVerifier = options.codeVerifier;
    if (options.redirectUri !== undefined)
      this.redirectUri = options.redirectUri;
    if (options.scopes !== undefined) this.scopes = options.scopes;
    if (options.expiresAt !== undefined) this.expiresAt = options.expiresAt;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if the state has expired
   */
  get isExpired(): boolean {
    return Date.now() >= this.expiresAt.getTime();
  }

  /**
   * Check if the state is still valid
   */
  get isValid(): boolean {
    return !this.isExpired && this.state.length > 0;
  }

  /**
   * Verify a callback state matches this record
   */
  verifyState(callbackState: string): boolean {
    return this.isValid && this.state === callbackState;
  }

  /**
   * Generate a new random state token
   */
  static generateState(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate a PKCE code verifier
   * Returns a 43-128 character random string
   */
  static generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }

  /**
   * Generate PKCE code challenge from verifier (S256 method)
   * Note: This requires async crypto operations
   */
  static async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
}
