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
    const [approved, scheduled] = await Promise.all([
      this.list({
        where: { status: 'approved' },
        orderBy: 'scheduledAt ASC',
      }),
      this.list({
        where: { status: 'scheduled', 'scheduledAt <=': now },
        orderBy: 'scheduledAt ASC',
      }),
    ]);

    return [
      ...approved.filter((post) => post.isDueForPublish),
      ...scheduled,
    ].sort(
      (a, b) =>
        (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0),
    );
  }

  async recordPublishSuccess(
    post: SocialPost,
    data: PublishSuccessData,
  ): Promise<SocialPost> {
    const status = data.status ?? 'published';
    post.platformPostId = data.platformPostId;
    post.platformUrl = data.platformUrl;
    if (status === 'published') {
      post.publishedAt = data.publishedAt ?? post.publishedAt ?? new Date();
    }
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
    post.errorMessage = formatPublishError(error);
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

function formatPublishError(error: Error | string): string {
  if (typeof error === 'string') {
    return error;
  }

  const details = [error.message];
  const code = (error as Error & { code?: unknown }).code;
  if (code !== undefined) {
    details.push(`code=${String(code)}`);
  }
  if (error.stack) {
    details.push(error.stack);
  }
  return details.join('\n');
}
