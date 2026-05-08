import { describe, expect, it, vi } from 'vitest';
import {
  SocialAccount,
  SocialPost,
  SocialPostAnalyticsSnapshot,
  SocialPostCollection,
} from './index.js';

describe('smrt-social models', () => {
  it('marks secret-backed connected accounts as ready', () => {
    const account = new SocialAccount({
      name: 'Bentley Facebook',
      platform: 'facebook',
      credentialSecretId: 'social-account-1',
      status: 'connected',
    });

    expect(account.hasCredentials).toBe(true);
    expect(account.isReady).toBe(true);
    expect(account.needsAttention).toBe(false);
    expect(account.effectivePublishMode).toBe('dry_run');
  });

  it('requires an explicit latch for public publishing', () => {
    const blocked = new SocialAccount({
      name: 'Bentley X',
      platform: 'x',
      credentialSecretId: 'social-account-x',
      status: 'connected',
      publishMode: 'public',
      publicPublishingAllowed: false,
    });
    const allowed = new SocialAccount({
      name: 'Bentley X',
      platform: 'x',
      credentialSecretId: 'social-account-x',
      status: 'connected',
      publishMode: 'public',
      publicPublishingAllowed: true,
    });

    expect(blocked.isReady).toBe(false);
    expect(blocked.needsAttention).toBe(true);
    expect(blocked.effectivePublishMode).toBe('dry_run');
    expect(allowed.isReady).toBe(true);
    expect(allowed.effectivePublishMode).toBe('public');
  });

  it('marks accounts with missing permissions as needing attention', () => {
    const account = new SocialAccount({
      name: 'Bentley Facebook',
      platform: 'facebook',
      credentialSecretId: 'social-account-1',
      status: 'connected',
      missingPermissions: ['pages_manage_posts'],
    });

    expect(account.isReady).toBe(false);
    expect(account.needsAttention).toBe(true);
  });

  it('generates platform-scoped slugs for accounts with the same handle', async () => {
    const x = new SocialAccount({
      tenantId: 'root-blindmanpress',
      name: 'buddyrandom',
      platform: 'x',
      platformUsername: 'buddyrandom',
    });
    const youtube = new SocialAccount({
      tenantId: 'root-blindmanpress',
      name: 'buddyrandom',
      platform: 'youtube',
      platformUsername: 'buddyrandom',
    });

    expect(await x.getSlug()).toBe('root-blindmanpress-x-buddyrandom');
    expect(await youtube.getSlug()).toBe(
      'root-blindmanpress-youtube-buddyrandom',
    );
  });

  it('tracks post type, due state, and analytics sync metadata', () => {
    const post = new SocialPost({
      socialAccountId: 'account-1',
      postType: 'link',
      linkUrl: 'https://bentleyalberta.com/story',
      status: 'approved',
      analytics: {
        views: 12,
        likes: 3,
        raw: { source: 'platform' },
      },
      analyticsLastSyncedAt: new Date('2026-05-07T12:00:00Z'),
    });

    expect(post.postType).toBe('link');
    expect(post.isDueForPublish).toBe(true);
    expect(post.analytics.raw).toEqual({ source: 'platform' });
    expect(post.analyticsLastSyncedAt?.toISOString()).toBe(
      '2026-05-07T12:00:00.000Z',
    );
  });

  it('does not stamp dry-run or staged posts as published', async () => {
    const post = new SocialPost({
      socialAccountId: 'account-1',
      postType: 'link',
      status: 'publishing',
    });
    post.save = vi.fn(async () => post);

    await SocialPostCollection.prototype.recordPublishSuccess.call(
      {} as SocialPostCollection,
      post,
      {
        platformPostId: 'x-dry-run-1',
        platformUrl: '',
        status: 'dry_run',
      },
    );

    expect(post.status).toBe('dry_run');
    expect(post.publishedAt).toBeNull();
    expect(post.save).toHaveBeenCalledOnce();
  });

  it('stores normalized and raw analytics snapshots', () => {
    const snapshot = new SocialPostAnalyticsSnapshot({
      socialPostId: 'post-1',
      platform: 'x',
      analytics: {
        views: 100,
        impressions: 110,
        likes: 8,
        lastUpdated: new Date('2026-05-07T13:00:00Z'),
      },
      raw: { public_metrics: { impression_count: 110 } },
      capturedAt: new Date('2026-05-07T13:00:00Z'),
    });

    expect(snapshot.analytics.impressions).toBe(110);
    expect(snapshot.raw).toEqual({
      public_metrics: { impression_count: 110 },
    });
  });
});
