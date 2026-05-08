import { SmrtCollection } from '@happyvertical/smrt-core';
import type { SocialPlatformType } from '../social-account.js';
import type { PostAnalytics } from '../social-post.js';
import {
  type RawAnalyticsPayload,
  SocialPostAnalyticsSnapshot,
} from '../social-post-analytics-snapshot.js';

function isRawAnalyticsPayload(value: unknown): value is RawAnalyticsPayload {
  return (
    value === null ||
    Array.isArray(value) ||
    (typeof value === 'object' && value !== null)
  );
}

export class SocialPostAnalyticsSnapshotCollection extends SmrtCollection<SocialPostAnalyticsSnapshot> {
  static readonly _itemClass = SocialPostAnalyticsSnapshot;

  async recordSnapshot(options: {
    socialPostId: string;
    platform: SocialPlatformType;
    metrics: PostAnalytics;
    raw?: RawAnalyticsPayload;
    capturedAt?: Date;
    tenantId?: string | null;
  }): Promise<SocialPostAnalyticsSnapshot> {
    const snapshot = await this.create({
      socialPostId: options.socialPostId,
      platform: options.platform,
      analytics: options.metrics,
      raw:
        options.raw ??
        (isRawAnalyticsPayload(options.metrics.raw)
          ? options.metrics.raw
          : null),
      capturedAt: options.capturedAt ?? new Date(),
      tenantId: options.tenantId,
    });
    return snapshot;
  }

  async findForPost(
    socialPostId: string,
  ): Promise<SocialPostAnalyticsSnapshot[]> {
    return this.list({
      where: { socialPostId },
      orderBy: 'capturedAt DESC',
    });
  }

  async findLatestForPost(
    socialPostId: string,
  ): Promise<SocialPostAnalyticsSnapshot | null> {
    const snapshots = await this.findForPost(socialPostId);
    return snapshots[0] ?? null;
  }
}
