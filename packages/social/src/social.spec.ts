import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { SecretService } from '@happyvertical/smrt-secrets';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OAuthStateCollection,
  SocialAccount,
  SocialAccountCollection,
  SocialPost,
  SocialPostAnalyticsSnapshot,
  SocialPostAnalyticsSnapshotCollection,
  SocialPostCollection,
} from './index.js';
import {
  normalizeManualCredentials,
  validateManualCredentials,
} from './server.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function withSocialTestDb<T>(
  fn: (db: DatabaseInterface) => Promise<T>,
): Promise<T> {
  const db = await getTestDatabase({
    classes: [
      'SocialAccount',
      'SocialPost',
      'SocialPostAnalyticsSnapshot',
      'OAuthState',
      'Secret',
      'SecretAuditLog',
    ],
  });
  try {
    return await fn(db);
  } finally {
    await db.close?.();
  }
}

describe('smrt-social models', () => {
  afterEach(() => {
    disableTenancy();
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

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
    expect(account.effectivePublishMode).toBe('private_or_scheduled');
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

    expect(await x.getSlug()).toBe('tenant-root-blindmanpress-x-buddyrandom');
    expect(await youtube.getSlug()).toBe(
      'tenant-root-blindmanpress-youtube-buddyrandom',
    );
  });

  it('does not mint a slug before an account has a stable identity', async () => {
    const account = new SocialAccount({ platform: 'x' });

    expect(await account.getSlug()).toBeNull();
    expect(account.slug).toBeNull();
  });

  it('keeps tenant slug scope distinct from the no-tenant sentinel', async () => {
    const tenantGlobal = new SocialAccount({
      tenantId: 'global',
      platform: 'x',
      platformUsername: 'localnews',
    });
    const noTenant = new SocialAccount({
      platform: 'x',
      platformUsername: 'localnews',
    });

    expect(await tenantGlobal.getSlug()).toBe('tenant-global-x-localnews');
    expect(await noTenant.getSlug()).toBe('no-tenant-x-localnews');
  });

  it('applies platform setup defaults unless explicitly overridden', () => {
    const x = new SocialAccount({ platform: 'x' });
    const youtube = new SocialAccount({ platform: 'youtube' });
    const explicit = new SocialAccount({
      platform: 'x',
      linkBehavior: 'reply',
      publishMode: 'public',
    });

    expect(x.linkBehavior).toBe('inline');
    expect(x.publishMode).toBe('dry_run');
    expect(youtube.publishMode).toBe('private_or_scheduled');
    expect(explicit.linkBehavior).toBe('reply');
    expect(explicit.publishMode).toBe('public');
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
    await withSocialTestDb(async (db) => {
      const posts = await SocialPostCollection.create({ db });
      const post = await posts.create({
        socialAccountId: 'account-1',
        postType: 'link',
        status: 'publishing',
      });

      await posts.recordPublishSuccess(post, {
        platformPostId: 'x-dry-run-1',
        platformUrl: '',
        status: 'dry_run',
      });

      const loaded = await posts.get({ id: post.id });
      expect(loaded?.status).toBe('dry_run');
      expect(loaded?.publishedAt).toBeNull();
    });
  });

  it('preserves an existing published timestamp when a later staged write succeeds', async () => {
    await withSocialTestDb(async (db) => {
      const posts = await SocialPostCollection.create({ db });
      const publishedAt = new Date('2026-05-07T12:00:00Z');
      const post = await posts.create({
        socialAccountId: 'account-1',
        postType: 'link',
        status: 'publishing',
        publishedAt,
      });

      await posts.recordPublishSuccess(post, {
        platformPostId: 'threads-container-1',
        platformUrl: '',
        status: 'staged',
      });

      const loaded = await posts.get({ id: post.id });
      expect(loaded?.status).toBe('staged');
      expect(loaded?.publishedAt?.toISOString()).toBe(
        publishedAt.toISOString(),
      );
    });
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

  it('stores and retrieves account credentials in the account tenant', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
    enableTenancy();

    await withSocialTestDb(async (db) => {
      const accounts = await SocialAccountCollection.create({ db });
      const account = new SocialAccount({
        db,
        tenantId: 'tenant-a',
        name: 'Tenant A X',
        platform: 'x',
      });
      await account.initialize();

      await withTenant({ tenantId: 'tenant-b' }, async () => {
        await account.setCredentials({
          accessToken: 'tenant-a-access',
          refreshToken: 'tenant-a-refresh',
        });
      });

      const loaded = await withTenant({ tenantId: 'tenant-a' }, () =>
        accounts.get({ id: account.id }),
      );
      const credentials = await withTenant({ tenantId: 'tenant-b' }, () =>
        loaded?.getCredentials(),
      );

      expect(loaded?.tenantId).toBe('tenant-a');
      expect(loaded?.credentialSecretId).toBe(`social-account-${account.id}`);
      expect(credentials).toEqual({
        accessToken: 'tenant-a-access',
        refreshToken: 'tenant-a-refresh',
      });
    });
  });

  it('retrieves split access and refresh token secret references', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;

    await withSocialTestDb(async (db) => {
      const secrets = await SecretService.create({ db });
      await secrets.storeForTenant('tenant-a', 'x-access', 'access-token');
      await secrets.storeForTenant('tenant-a', 'x-refresh', 'refresh-token');

      const account = new SocialAccount({
        db,
        tenantId: 'tenant-a',
        platform: 'x',
        accessTokenSecretName: 'x-access',
        refreshTokenSecretName: 'x-refresh',
      });
      await account.initialize();

      await expect(account.getCredentials()).resolves.toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      expect(account.hasCredentials).toBe(true);
    });
  });

  it('reports a clear error when secret-backed credentials lack tenant context', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;

    await withSocialTestDb(async (db) => {
      const account = new SocialAccount({
        db,
        platform: 'x',
      });

      await expect(
        account.setCredentials({ accessToken: 'token' }),
      ).rejects.toThrow(
        'Tenant context required to store social account credentials.',
      );
    });
  });

  it('filters account readiness helpers through the collection', async () => {
    await withSocialTestDb(async (db) => {
      const accounts = await SocialAccountCollection.create({ db });

      const ready = await accounts.create({
        name: 'Ready X',
        platform: 'x',
        credentialSecretId: 'ready-secret',
        status: 'connected',
      });
      await accounts.create({
        name: 'Missing permission X',
        platform: 'x',
        credentialSecretId: 'missing-secret',
        status: 'connected',
        missingPermissions: ['tweet.write'],
      });
      await accounts.create({
        name: 'Inactive X',
        platform: 'x',
        credentialSecretId: 'inactive-secret',
        status: 'connected',
        isActive: false,
      });

      const readyAccounts = await accounts.findReady('x');
      const needsAttention = await accounts.findNeedsAttention();

      expect(readyAccounts.map((account) => account.id)).toEqual([ready.id]);
      expect(needsAttention.map((account) => account.name)).toEqual([
        'Missing permission X',
      ]);
    });
  });

  it('finds only posts that are due for publish', async () => {
    await withSocialTestDb(async (db) => {
      const posts = await SocialPostCollection.create({ db });
      const now = new Date('2026-05-08T12:00:00Z');
      const approved = await posts.create({
        socialAccountId: 'account-1',
        status: 'approved',
      });
      const scheduledDue = await posts.create({
        socialAccountId: 'account-1',
        status: 'scheduled',
        scheduledAt: new Date('2026-05-08T11:00:00Z'),
      });
      await posts.create({
        socialAccountId: 'account-1',
        status: 'scheduled',
        scheduledAt: new Date('2026-05-08T13:00:00Z'),
      });
      await posts.create({
        socialAccountId: 'account-1',
        status: 'draft',
      });

      const due = await posts.findDueForPublish(now);

      expect(due.map((post) => post.id)).toEqual([
        approved.id,
        scheduledDue.id,
      ]);
    });
  });

  it('creates drafts and records failure plus analytics lifecycle updates', async () => {
    await withSocialTestDb(async (db) => {
      const posts = await SocialPostCollection.create({ db });
      const syncedAt = new Date('2026-05-08T12:30:00Z');
      const draft = await posts.createDraft({
        socialAccountId: 'account-1',
        linkUrl: 'https://bentleyalberta.com/story',
      });
      const scheduled = await posts.createDraft({
        socialAccountId: 'account-1',
        mediaUrl: 'https://assets.example/video.mp4',
        scheduledAt: new Date('2026-05-08T13:00:00Z'),
      });
      const publishError = Object.assign(new Error('Publish failed'), {
        code: 'E_PLATFORM',
      });

      expect(draft.postType).toBe('link');
      expect(draft.status).toBe('draft');
      expect(scheduled.postType).toBe('video');
      expect(scheduled.status).toBe('scheduled');

      await posts.recordPublishFailure(draft, publishError);
      let loaded = await posts.get({ id: draft.id });
      expect(loaded?.status).toBe('failed');
      expect(loaded?.errorMessage).toContain('Publish failed');
      expect(loaded?.errorMessage).toContain('code=E_PLATFORM');

      await posts.updateLatestAnalytics(draft, { likes: 3 }, syncedAt);
      loaded = await posts.get({ id: draft.id });
      expect(loaded?.analytics).toMatchObject({
        likes: 3,
        lastUpdated: syncedAt.toISOString(),
      });
      expect(loaded?.analyticsLastSyncedAt?.toISOString()).toBe(
        syncedAt.toISOString(),
      );
    });
  });

  it('finds and deletes expired oauth states through query filters', async () => {
    await withSocialTestDb(async (db) => {
      const states = await OAuthStateCollection.create({ db });
      const now = new Date('2026-05-08T12:00:00Z');
      const expired = await states.create({
        state: 'expired',
        expiresAt: new Date('2026-05-08T11:59:00Z'),
      });
      await states.create({
        state: 'future',
        expiresAt: new Date('2026-05-08T12:01:00Z'),
      });

      const found = await states.findExpired(now);
      const deleted = await states.deleteExpired(now);

      expect(found.map((state) => state.id)).toEqual([expired.id]);
      expect(deleted).toBe(1);
      await expect(states.findByState('expired')).resolves.toBeNull();
      await expect(states.findByState('future')).resolves.not.toBeNull();
    });
  });

  it('records analytics snapshots and exposes the latest snapshot for a post', async () => {
    await withSocialTestDb(async (db) => {
      const snapshots = await SocialPostAnalyticsSnapshotCollection.create({
        db,
      });
      await snapshots.recordSnapshot({
        socialPostId: 'post-1',
        platform: 'x',
        metrics: {
          views: 10,
          raw: { public_metrics: { impression_count: 10 } },
        },
        capturedAt: new Date('2026-05-08T11:00:00Z'),
      });
      const latest = await snapshots.recordSnapshot({
        socialPostId: 'post-1',
        platform: 'x',
        metrics: { views: 12 },
        raw: { public_metrics: { impression_count: 12 } },
        capturedAt: new Date('2026-05-08T12:00:00Z'),
      });

      await expect(
        snapshots.findLatestForPost('post-1'),
      ).resolves.toMatchObject({
        id: latest.id,
        platform: 'x',
        analytics: { views: 12 },
        raw: { public_metrics: { impression_count: 12 } },
      });
    });
  });

  it('leaves analytics snapshot platform unset until the caller provides it', () => {
    const snapshot = new SocialPostAnalyticsSnapshot();

    expect(snapshot.platform).toBeNull();
  });

  it('validates manual credential fields before normalization', () => {
    expect(
      validateManualCredentials('x', {
        apiKey: 'key',
        apiSecret: 'secret',
        accessToken: 'token',
      }),
    ).toEqual(['accessSecret']);

    expect(
      normalizeManualCredentials('x', {
        apiKey: ' key ',
        apiSecret: ' secret ',
        accessToken: ' token ',
        accessSecret: '',
      }),
    ).toEqual({
      apiKey: 'key',
      apiSecret: 'secret',
      accessToken: 'token',
    });
  });
});
