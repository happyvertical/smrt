/**
 * Social Post Model
 *
 * Manages posts published or scheduled to social media platforms.
 * Tracks publishing status and engagement analytics.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VideoContent } from '@happyvertical/smrt-video';
import { SocialAccount } from './social-account.js';

/**
 * Post status
 */
export type PostStatus =
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed';

/**
 * Post analytics
 */
export interface PostAnalytics {
  /**
   * View/impression count
   */
  views?: number;

  /**
   * Like/favorite count
   */
  likes?: number;

  /**
   * Comment count
   */
  comments?: number;

  /**
   * Share/repost count
   */
  shares?: number;

  /**
   * Link click count
   */
  clicks?: number;

  /**
   * When analytics were last updated
   */
  lastUpdated?: Date;
}

/**
 * Social post creation options
 */
export interface SocialPostOptions extends SmrtObjectOptions {
  /**
   * Social account to publish to
   */
  socialAccountId?: string | null;

  /**
   * Video content to publish
   */
  videoContentId?: string | null;

  /**
   * Generic content ID (for non-video content)
   */
  contentId?: string | null;

  /**
   * Post title (for platforms that support it)
   */
  title?: string | null;

  /**
   * Post description/caption
   */
  description?: string;

  /**
   * Hashtags to include
   */
  hashtags?: string[];

  /**
   * Link URL to include
   */
  linkUrl?: string | null;

  /**
   * Platform-specific post ID (after publishing)
   */
  platformPostId?: string | null;

  /**
   * Public post URL (after publishing)
   */
  platformUrl?: string | null;

  /**
   * Scheduled publish time
   */
  scheduledAt?: Date | null;

  /**
   * Actual publish time
   */
  publishedAt?: Date | null;

  /**
   * Post status
   * @default 'draft'
   */
  status?: PostStatus;

  /**
   * Error message if status is 'failed'
   */
  errorMessage?: string | null;

  /**
   * Engagement analytics
   */
  analytics?: PostAnalytics;

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Social media post for multi-platform publishing
 *
 * SocialPost represents a post published or scheduled to a social
 * platform. It tracks publishing status and engagement analytics,
 * and can reference VideoContent for video posts.
 *
 * @example
 * ```typescript
 * import { SocialPost } from '@happyvertical/smrt-social';
 *
 * const post = new SocialPost({
 *   socialAccountId: 'account-123',
 *   videoContentId: 'video-456',
 *   title: 'Breaking News from Bentley',
 *   description: 'Latest updates from the town council meeting.',
 *   hashtags: ['news', 'local', 'bentley'],
 *   linkUrl: 'https://example.com/article',
 *   scheduledAt: new Date('2026-01-26T18:00:00Z'),
 * });
 * await post.save();
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
export class SocialPost extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Social account to publish to
   */
  @foreignKey(() => SocialAccount)
  socialAccountId: string | null = null;

  /**
   * Video content to publish
   */
  @foreignKey(() => VideoContent)
  videoContentId: string | null = null;

  /**
   * Generic content ID (for non-video content)
   */
  contentId: string | null = null;

  /**
   * Post title (for platforms that support it)
   */
  title: string | null = null;

  /**
   * Post description/caption
   */
  description: string = '';

  /**
   * Hashtags to include
   */
  hashtags: string[] = [];

  /**
   * Link URL to include in the post
   */
  linkUrl: string | null = null;

  /**
   * Platform-specific post ID (set after publishing)
   */
  platformPostId: string | null = null;

  /**
   * Public post URL (set after publishing)
   */
  platformUrl: string | null = null;

  /**
   * Scheduled publish time
   * If set, post will be scheduled instead of published immediately
   */
  scheduledAt: Date | null = null;

  /**
   * Actual publish time
   */
  publishedAt: Date | null = null;

  /**
   * Post status
   * - draft: Not yet submitted for publishing
   * - scheduled: Queued for future publishing
   * - publishing: Currently being published
   * - published: Successfully published
   * - failed: Publishing failed
   */
  status: PostStatus = 'draft';

  /**
   * Error message if status is 'failed'
   */
  errorMessage: string | null = null;

  /**
   * Engagement analytics
   */
  analytics: PostAnalytics = {};

  constructor(options: SocialPostOptions = {}) {
    super(options);

    if (options.socialAccountId !== undefined)
      this.socialAccountId = options.socialAccountId;
    if (options.videoContentId !== undefined)
      this.videoContentId = options.videoContentId;
    if (options.contentId !== undefined) this.contentId = options.contentId;
    if (options.title !== undefined) this.title = options.title;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.hashtags !== undefined) this.hashtags = options.hashtags;
    if (options.linkUrl !== undefined) this.linkUrl = options.linkUrl;
    if (options.platformPostId !== undefined)
      this.platformPostId = options.platformPostId;
    if (options.platformUrl !== undefined)
      this.platformUrl = options.platformUrl;
    if (options.scheduledAt !== undefined)
      this.scheduledAt = options.scheduledAt;
    if (options.publishedAt !== undefined)
      this.publishedAt = options.publishedAt;
    if (options.status !== undefined) this.status = options.status;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.analytics !== undefined) this.analytics = options.analytics;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if the post is scheduled for future publishing
   */
  get isScheduled(): boolean {
    return this.status === 'scheduled' && this.scheduledAt !== null;
  }

  /**
   * Check if the post has been published
   */
  get isPublished(): boolean {
    return this.status === 'published';
  }

  /**
   * Check if the post can be edited (draft or failed)
   */
  get isEditable(): boolean {
    return this.status === 'draft' || this.status === 'failed';
  }

  /**
   * Get formatted hashtag string
   */
  get hashtagString(): string {
    return this.hashtags
      .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
      .join(' ');
  }

  /**
   * Get the full post text with hashtags
   */
  get fullText(): string {
    const parts = [this.description];
    if (this.hashtags.length > 0) {
      parts.push(this.hashtagString);
    }
    return parts.join('\n\n');
  }
}
