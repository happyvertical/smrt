/**
 * Social Post Analytics Snapshot Model
 *
 * Stores timestamped normalized and raw platform analytics payloads.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { SocialPlatformType } from './social-account.js';
import { type PostAnalytics, SocialPost } from './social-post.js';

export type RawAnalyticsPayload = Record<string, unknown> | unknown[] | null;

export interface SocialPostAnalyticsSnapshotOptions extends SmrtObjectOptions {
  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;

  /**
   * Social post being measured
   */
  socialPostId?: string | null;

  /**
   * Platform that produced this snapshot
   */
  platform?: SocialPlatformType;

  /**
   * Normalized platform analytics.
   */
  analytics?: PostAnalytics;

  /**
   * Raw platform payload
   */
  raw?: RawAnalyticsPayload;

  /**
   * When the platform data was captured
   */
  capturedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'delete'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class SocialPostAnalyticsSnapshot extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey(() => SocialPost)
  socialPostId: string | null = null;

  platform: SocialPlatformType = 'youtube';

  analytics: PostAnalytics = {};

  @field({ type: 'json', nullable: true })
  raw: RawAnalyticsPayload = null;

  capturedAt: Date = new Date();

  constructor(options: SocialPostAnalyticsSnapshotOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.socialPostId !== undefined)
      this.socialPostId = options.socialPostId;
    if (options.platform !== undefined) this.platform = options.platform;
    if (options.analytics !== undefined) this.analytics = options.analytics;
    if (options.raw !== undefined) this.raw = options.raw;
    if (options.capturedAt !== undefined) this.capturedAt = options.capturedAt;
  }
}
