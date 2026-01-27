/**
 * Social Account Model
 *
 * Manages connected social media platform accounts for publishing.
 * Stores OAuth credentials and account settings.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Supported social platforms
 */
export type SocialPlatformType = 'youtube' | 'threads' | 'x' | 'bluesky';

/**
 * Account connection status
 */
export type AccountStatus = 'connected' | 'expired' | 'error';

/**
 * Link behavior for posts with links
 */
export type LinkBehavior = 'description' | 'reply' | 'none';

/**
 * Social account creation options
 */
export interface SocialAccountOptions extends SmrtObjectOptions {
  /**
   * Human-readable name for the account
   */
  name?: string;

  /**
   * Social platform type
   */
  platform?: SocialPlatformType;

  /**
   * Platform-specific user ID
   */
  platformUserId?: string | null;

  /**
   * Platform username/handle
   */
  platformUsername?: string | null;

  /**
   * Profile URL on the platform
   */
  platformUrl?: string | null;

  /**
   * Encrypted OAuth access token
   */
  accessToken?: string | null;

  /**
   * Encrypted OAuth refresh token
   */
  refreshToken?: string | null;

  /**
   * Token expiration time
   */
  tokenExpiresAt?: Date | null;

  /**
   * Whether the account is active
   * @default true
   */
  isActive?: boolean;

  /**
   * Default hashtags to add to posts
   */
  defaultHashtags?: string[];

  /**
   * How to handle links in posts
   * @default 'description'
   */
  linkBehavior?: LinkBehavior;

  /**
   * Account connection status
   * @default 'connected'
   */
  status?: AccountStatus;

  /**
   * Error message if status is 'error'
   */
  errorMessage?: string | null;

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Connected social media account for publishing
 *
 * SocialAccount represents a connected social platform account
 * with OAuth credentials and publishing settings. Accounts can
 * be used to publish content to multiple platforms.
 *
 * @example
 * ```typescript
 * import { SocialAccount } from '@happyvertical/smrt-social';
 *
 * const account = new SocialAccount({
 *   name: 'Bentley News YouTube',
 *   platform: 'youtube',
 *   platformUserId: 'UC...',
 *   platformUsername: 'Bentley News',
 *   accessToken: '...encrypted...',
 *   refreshToken: '...encrypted...',
 *   tokenExpiresAt: new Date('2026-02-25'),
 *   defaultHashtags: ['news', 'local', 'bentley'],
 *   linkBehavior: 'description',
 * });
 * await account.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class SocialAccount extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Human-readable name for the account
   */
  name: string = '';

  /**
   * Social platform type
   */
  platform: SocialPlatformType = 'youtube';

  /**
   * Platform-specific user ID
   */
  platformUserId: string | null = null;

  /**
   * Platform username/handle
   */
  platformUsername: string | null = null;

  /**
   * Profile URL on the platform
   */
  platformUrl: string | null = null;

  /**
   * Encrypted OAuth access token
   * WARNING: This should be encrypted before storage
   */
  accessToken: string | null = null;

  /**
   * Encrypted OAuth refresh token
   * WARNING: This should be encrypted before storage
   */
  refreshToken: string | null = null;

  /**
   * Token expiration time
   */
  tokenExpiresAt: Date | null = null;

  /**
   * Whether the account is active
   */
  isActive: boolean = true;

  /**
   * Default hashtags to add to posts
   */
  defaultHashtags: string[] = [];

  /**
   * How to handle links in posts
   * - description: Include link in post body/description
   * - reply: Post link as a reply (better for X algorithm)
   * - none: Don't include link
   */
  linkBehavior: LinkBehavior = 'description';

  /**
   * Account connection status
   */
  status: AccountStatus = 'connected';

  /**
   * Error message if status is 'error'
   */
  errorMessage: string | null = null;

  constructor(options: SocialAccountOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.platform !== undefined) this.platform = options.platform;
    if (options.platformUserId !== undefined)
      this.platformUserId = options.platformUserId;
    if (options.platformUsername !== undefined)
      this.platformUsername = options.platformUsername;
    if (options.platformUrl !== undefined)
      this.platformUrl = options.platformUrl;
    if (options.accessToken !== undefined)
      this.accessToken = options.accessToken;
    if (options.refreshToken !== undefined)
      this.refreshToken = options.refreshToken;
    if (options.tokenExpiresAt !== undefined)
      this.tokenExpiresAt = options.tokenExpiresAt;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.defaultHashtags !== undefined)
      this.defaultHashtags = options.defaultHashtags;
    if (options.linkBehavior !== undefined)
      this.linkBehavior = options.linkBehavior;
    if (options.status !== undefined) this.status = options.status;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if the token is expired or will expire soon
   */
  get isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false;
    // Expire 5 minutes early to allow for refresh
    const expiryBuffer = 5 * 60 * 1000;
    return Date.now() >= this.tokenExpiresAt.getTime() - expiryBuffer;
  }

  /**
   * Check if the account needs attention (expired or error)
   */
  get needsAttention(): boolean {
    return this.status !== 'connected' || this.isTokenExpired;
  }

  /**
   * Check if the account is ready for publishing
   */
  get isReady(): boolean {
    return (
      this.isActive &&
      this.status === 'connected' &&
      this.accessToken !== null &&
      !this.isTokenExpired
    );
  }
}
