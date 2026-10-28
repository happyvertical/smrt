/**
 * Declared recipes for smrt-social (#4409): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * `OAuthState` is deliberately not listed: it is the sign-in handshake record,
 * not something a person opens.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { SocialAccount } from './social-account.js';
import { SocialPost } from './social-post.js';
import { SocialPostAnalyticsSnapshot } from './social-post-analytics-snapshot.js';

/** Social: Write posts for your social accounts and see how each one did. */
export class SocialPostsRecipe extends SmrtRecipe {
  static id = 'social.posts';
  static help = './posts.recipe.md';
  static label = 'Social';
  static summary =
    'Write posts for your YouTube, X, Threads and Bluesky accounts, plan when they go out and see how each one did.';
  static synonyms = [
    'social media',
    'social posts',
    'social accounts',
    'youtube',
    'bluesky',
    'threads',
    'tweets',
    'post results',
  ];
  static section = {
    id: 'publish',
    label: 'Publish',
    icon: 'fileText',
    description: 'What you write, record and put out.',
  };
  static models = [SocialPost, SocialAccount, SocialPostAnalyticsSnapshot];
  static nav = [
    {
      label: 'Posts',
      model: SocialPost,
      icon: 'fileText',
      description:
        'What you have written for each account and where it stands.',
      noun: 'post',
    },
    {
      label: 'Connected accounts',
      model: SocialAccount,
      icon: 'users',
      description: 'The social accounts you can post to, and their settings.',
      noun: 'account',
    },
    {
      label: 'Post results',
      model: SocialPostAnalyticsSnapshot,
      icon: 'eye',
      description:
        'The views, likes and other numbers each platform reported for a post.',
    },
  ];
  static options = {
    SocialPost: {
      fields: {
        socialAccountId: { label: 'Account', order: 1 },
        title: { order: 2 },
        description: { label: 'Text', order: 3 },
        hashtags: { order: 4 },
        linkUrl: { label: 'Link', order: 5 },
        postType: { label: 'Kind of post', order: 6 },
        scheduledAt: { label: 'Planned for', order: 7 },
        status: { locked: true, order: 8 },
        publishedAt: { label: 'Published on', locked: true, order: 9 },
        platformUrl: { label: 'Link to the post', locked: true, order: 10 },
        videoContentId: { label: 'Video', visibility: 'advanced' },
        contentId: { label: 'Content', visibility: 'advanced' },
        mediaUrl: { label: 'Media link', visibility: 'advanced' },
        errorMessage: { label: 'What went wrong', visibility: 'advanced' },
        analyticsLastSyncedAt: {
          label: 'Results last updated',
          visibility: 'advanced',
        },
        tenantId: { visibility: 'hidden' },
        createdByUserId: { visibility: 'hidden' },
        platformPostId: { visibility: 'hidden' },
        analytics: { visibility: 'hidden' },
      },
    },
    SocialAccount: {
      fields: {
        name: { order: 1 },
        platform: { order: 2 },
        platformUsername: { label: 'Username', order: 3 },
        platformUrl: { label: 'Profile link', order: 4 },
        status: { locked: true, order: 5 },
        isActive: { label: 'In use', order: 6 },
        defaultHashtags: { order: 7 },
        linkBehavior: { label: 'Where links go', order: 8 },
        publishMode: { label: 'Publishing mode', visibility: 'advanced' },
        publicPublishingAllowed: {
          label: 'Allow public posts',
          visibility: 'advanced',
        },
        platformUserId: { visibility: 'advanced' },
        tokenExpiresAt: { label: 'Connection expires', visibility: 'advanced' },
        scopes: { label: 'Permissions granted', visibility: 'advanced' },
        missingPermissions: { visibility: 'advanced' },
        errorMessage: { label: 'What went wrong', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        accessToken: { visibility: 'hidden' },
        refreshToken: { visibility: 'hidden' },
        credentialSecretId: { visibility: 'hidden' },
        accessTokenSecretName: { visibility: 'hidden' },
        refreshTokenSecretName: { visibility: 'hidden' },
      },
    },
    SocialPostAnalyticsSnapshot: {
      fields: {
        socialPostId: { label: 'Post', order: 1 },
        platform: { order: 2 },
        capturedAt: { label: 'Measured on', order: 3 },
        analytics: { label: 'Numbers', order: 4 },
        tenantId: { visibility: 'hidden' },
        raw: { visibility: 'hidden' },
      },
    },
  } as const;
}
