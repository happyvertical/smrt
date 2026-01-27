/**
 * @happyvertical/smrt-social
 *
 * Social media account management for multi-platform publishing.
 *
 * This package provides models for managing social accounts, posts,
 * and OAuth flows in the SMRT ecosystem.
 *
 * @example
 * ```typescript
 * import {
 *   SocialAccount,
 *   SocialPost,
 *   OAuthState,
 * } from '@happyvertical/smrt-social';
 *
 * // Connect a social account
 * const account = new SocialAccount({
 *   name: 'Bentley News YouTube',
 *   platform: 'youtube',
 *   platformUsername: 'Bentley News',
 * });
 * await account.save();
 *
 * // Create a post
 * const post = new SocialPost({
 *   socialAccountId: account.id,
 *   description: 'Breaking news from Bentley!',
 *   hashtags: ['news', 'local'],
 * });
 * await post.save();
 * ```
 */

export {
  OAuthState,
  type OAuthStateOptions,
} from './oauth-state.js';
// Models
export {
  type AccountStatus,
  type LinkBehavior,
  SocialAccount,
  type SocialAccountOptions,
  type SocialPlatformType,
} from './social-account.js';
export {
  type PostAnalytics,
  type PostStatus,
  SocialPost,
  type SocialPostOptions,
} from './social-post.js';
