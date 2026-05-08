import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  type PostAnalytics,
  type PostStatus,
  SocialPost,
  type SocialPostType,
} from '../social-post.js';

export interface CreateSocialPostDraftOptions {
  socialAccountId: string;
  contentId?: string | null;
  videoContentId?: string | null;
  postType?: SocialPostType;
  title?: string | null;
  description?: string;
  hashtags?: string[];
  linkUrl?: string | null;
  mediaUrl?: string | null;
  scheduledAt?: Date | null;
  tenantId?: string | null;
}

export interface PublishSuccessData {
  platformPostId: string;
  platformUrl: string;
  publishedAt?: Date;
  status?: PostStatus;
}

export class SocialPostCollection extends SmrtCollection<SocialPost> {
  static readonly _itemClass = SocialPost;

  async createDraft(
    options: CreateSocialPostDraftOptions,
  ): Promise<SocialPost> {
    return this.create({
      ...options,
      postType:
        options.postType ??
        (options.videoContentId || options.mediaUrl
          ? 'video'
          : options.linkUrl
            ? 'link'
            : 'text'),
      status: options.scheduledAt ? 'scheduled' : 'draft',
    });
  }

  async findByStatus(status: PostStatus): Promise<SocialPost[]> {
    return this.list({ where: { status }, orderBy: 'scheduledAt ASC' });
  }

  async findForAccount(socialAccountId: string): Promise<SocialPost[]> {
    return this.list({
      where: { socialAccountId },
      orderBy: 'created_at DESC',
    });
  }

  async findDueForPublish(now: Date = new Date()): Promise<SocialPost[]> {
    const posts = await this.list({
      where: {},
      orderBy: 'scheduledAt ASC',
    });

    return posts.filter((post) => {
      if (post.status !== 'approved' && post.status !== 'scheduled') {
        return false;
      }
      return !post.scheduledAt || post.scheduledAt.getTime() <= now.getTime();
    });
  }

  async recordPublishSuccess(
    post: SocialPost,
    data: PublishSuccessData,
  ): Promise<SocialPost> {
    const status = data.status ?? 'published';
    post.platformPostId = data.platformPostId;
    post.platformUrl = data.platformUrl;
    post.publishedAt =
      data.publishedAt ?? (status === 'published' ? new Date() : null);
    post.status = status;
    post.errorMessage = null;
    await post.save();
    return post;
  }

  async recordPublishFailure(
    post: SocialPost,
    error: Error | string,
  ): Promise<SocialPost> {
    post.status = 'failed';
    post.errorMessage = error instanceof Error ? error.message : error;
    await post.save();
    return post;
  }

  async updateLatestAnalytics(
    post: SocialPost,
    analytics: PostAnalytics,
    syncedAt: Date = new Date(),
  ): Promise<SocialPost> {
    post.analytics = {
      ...analytics,
      lastUpdated: analytics.lastUpdated ?? syncedAt,
    };
    post.analyticsLastSyncedAt = syncedAt;
    await post.save();
    return post;
  }
}
