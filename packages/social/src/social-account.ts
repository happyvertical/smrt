/**
 * Social Account Model
 *
 * Manages connected social media platform accounts for publishing.
 * Stores OAuth credentials and account settings.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantScoped,
  tenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';

/**
 * Supported social platforms
 */
export type SocialPlatformType =
  | 'youtube'
  | 'threads'
  | 'x'
  | 'bluesky'
  | 'facebook';

/**
 * Account connection status
 */
export type AccountStatus =
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'missing_permissions'
  | 'error';

/**
 * Link behavior for posts with links
 */
export type LinkBehavior =
  | 'description'
  | 'inline'
  | 'attachment'
  | 'reply'
  | 'none';

/**
 * Controls how far publish operations are allowed to go.
 */
export type PublishMode =
  | 'dry_run'
  | 'stage_remote'
  | 'private_or_scheduled'
  | 'public';

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
   * Deprecated raw OAuth access token
   */
  accessToken?: string | null;

  /**
   * Deprecated raw OAuth refresh token
   */
  refreshToken?: string | null;

  /**
   * Secret name containing the full platform credential payload
   */
  credentialSecretId?: string | null;

  /**
   * Secret name containing the OAuth access token
   */
  accessTokenSecretName?: string | null;

  /**
   * Secret name containing the OAuth refresh token
   */
  refreshTokenSecretName?: string | null;

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
   * Granted OAuth scopes or platform permissions
   */
  scopes?: string[];

  /**
   * Required permissions that still need approval/granting
   */
  missingPermissions?: string[];

  /**
   * How to handle links in posts
   * @default 'description'
   */
  linkBehavior?: LinkBehavior;

  /**
   * Safety mode for publish operations.
   * @default 'dry_run'
   */
  publishMode?: PublishMode;

  /**
   * Separate latch required before public publishing can happen.
   * @default false
   */
  publicPublishingAllowed?: boolean;

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
   * Deprecated raw OAuth access token.
   * Prefer credentialSecretId/accessTokenSecretName.
   */
  accessToken: string | null = null;

  /**
   * Deprecated raw OAuth refresh token.
   * Prefer credentialSecretId/refreshTokenSecretName.
   */
  refreshToken: string | null = null;

  /**
   * Secret name containing the complete platform credential payload.
   */
  credentialSecretId: string | null = null;

  /**
   * Secret name containing only the access token.
   */
  accessTokenSecretName: string | null = null;

  /**
   * Secret name containing only the refresh token.
   */
  refreshTokenSecretName: string | null = null;

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
   * Granted OAuth scopes or platform permissions.
   */
  scopes: string[] = [];

  /**
   * Required permissions that still need app review or user grant.
   */
  missingPermissions: string[] = [];

  /**
   * How to handle links in posts
   * - description: Include link in post body/description
   * - reply: Post link as a reply (better for X algorithm)
   * - none: Don't include link
   */
  linkBehavior: LinkBehavior = 'description';

  /**
   * Safety mode for publish operations.
   */
  publishMode: PublishMode = 'dry_run';

  /**
   * Separate latch required before public publishing is allowed.
   */
  publicPublishingAllowed: boolean = false;

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
    if (options.credentialSecretId !== undefined)
      this.credentialSecretId = options.credentialSecretId;
    if (options.accessTokenSecretName !== undefined)
      this.accessTokenSecretName = options.accessTokenSecretName;
    if (options.refreshTokenSecretName !== undefined)
      this.refreshTokenSecretName = options.refreshTokenSecretName;
    if (options.tokenExpiresAt !== undefined)
      this.tokenExpiresAt = options.tokenExpiresAt;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.defaultHashtags !== undefined)
      this.defaultHashtags = options.defaultHashtags;
    if (options.scopes !== undefined) this.scopes = options.scopes;
    if (options.missingPermissions !== undefined)
      this.missingPermissions = options.missingPermissions;
    if (options.linkBehavior !== undefined)
      this.linkBehavior = options.linkBehavior;
    if (options.publishMode !== undefined)
      this.publishMode = options.publishMode;
    if (options.publicPublishingAllowed !== undefined)
      this.publicPublishingAllowed = options.publicPublishingAllowed;
    if (options.status !== undefined) this.status = options.status;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId;
    } else {
      const rawTenantId = (options as { tenant_id?: string | null }).tenant_id;
      if (rawTenantId !== undefined) {
        this.tenantId = rawTenantId;
      }
    }
  }

  /**
   * Social accounts need a slug identity that is scoped by tenant and platform.
   * A newsroom may connect `@localnews` on X, YouTube, Threads, and Facebook;
   * the generic name-derived slug would make those accounts overwrite each
   * other through SMRT's slug/context upsert identity.
   */
  async getSlug(): Promise<string | null | undefined> {
    if (!this.slug) {
      const identity =
        this.platformUserId || this.platformUsername || this.name || this.id;
      const source = [this.tenantId || 'global', this.platform, identity]
        .filter(Boolean)
        .join('-');

      this.slug = source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    }

    return this.slug;
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
    return (
      this.status !== 'connected' ||
      this.isTokenExpired ||
      this.missingPermissions.length > 0 ||
      (this.publishMode === 'public' && !this.publicPublishingAllowed)
    );
  }

  /**
   * Check if the account is ready for publishing
   */
  get isReady(): boolean {
    return (
      this.isActive &&
      this.status === 'connected' &&
      this.hasCredentials &&
      this.missingPermissions.length === 0 &&
      !this.isTokenExpired &&
      (this.publishMode !== 'public' || this.publicPublishingAllowed)
    );
  }

  /**
   * Effective publish mode after applying the public-publishing latch.
   */
  get effectivePublishMode(): PublishMode {
    if (this.publishMode === 'public' && !this.publicPublishingAllowed) {
      return 'dry_run';
    }
    return this.publishMode;
  }

  /**
   * Check whether any usable credential reference exists.
   */
  get hasCredentials(): boolean {
    return Boolean(
      this.credentialSecretId || this.accessTokenSecretName || this.accessToken,
    );
  }

  /**
   * Store all platform credentials in smrt-secrets as a single JSON payload.
   */
  async setCredentials(
    credentials: Record<string, unknown>,
    options: {
      description?: string;
      category?: string;
    } = {},
  ): Promise<void> {
    if (!this.id) {
      await this.save();
    }

    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });
    const secretName = this.credentialSecretId ?? `social-account-${this.id}`;
    const tenantId = this.getCredentialTenantId();

    if (tenantId) {
      await secretService.storeForTenant(
        tenantId,
        secretName,
        JSON.stringify(credentials),
        {
          description: options.description ?? `Credentials for ${this.name}`,
          category: options.category ?? 'social',
        },
      );
    } else {
      await secretService.store(secretName, JSON.stringify(credentials), {
        description: options.description ?? `Credentials for ${this.name}`,
        category: options.category ?? 'social',
      });
    }

    await this.withCredentialTenantContext(async () => {
      this.credentialSecretId = secretName;
      await this.save();
    });
  }

  /**
   * Retrieve platform credentials from smrt-secrets, falling back to deprecated fields.
   */
  async getCredentials(): Promise<Record<string, unknown> | null> {
    if (!this.credentialSecretId) {
      if (!this.accessToken && !this.refreshToken) return null;
      return {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
      };
    }

    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });

    const credentialSecretId = this.credentialSecretId;
    const tenantId = this.getCredentialTenantId();
    const secret = tenantId
      ? await secretService.retrieveForTenant(tenantId, credentialSecretId)
      : await this.withCredentialTenantContext(() =>
          secretService.retrieve(credentialSecretId),
        );
    return JSON.parse(secret.value);
  }

  private async withCredentialTenantContext<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    if (getCurrentTenant()) {
      return fn();
    }

    const tenantId = this.getCredentialTenantId();
    if (tenantId) {
      return withTenant({ tenantId }, fn);
    }

    return fn();
  }

  private getCredentialTenantId(): string | null {
    if (this.tenantId) {
      return this.tenantId;
    }

    const rawTenantId = (this as { tenant_id?: unknown }).tenant_id;
    return typeof rawTenantId === 'string' && rawTenantId.length > 0
      ? rawTenantId
      : null;
  }
}
