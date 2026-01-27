/**
 * @happyvertical/smrt-video
 *
 * Video content management for AI-powered video production.
 *
 * This package provides models for managing personality profiles, video content,
 * and ComfyUI workflows in the SMRT ecosystem.
 *
 * @example
 * ```typescript
 * import {
 *   PersonalityProfile,
 *   VideoContent,
 *   VideoWorkflow,
 * } from '@happyvertical/smrt-video';
 *
 * // Create a personality profile
 * const personality = new PersonalityProfile({
 *   name: 'News Anchor',
 *   imageAssetId: 'asset-123',
 *   voiceProfileId: 'voice-456',
 * });
 * await personality.save();
 *
 * // Create video content
 * const video = new VideoContent({
 *   personalityProfileId: personality.id,
 *   scriptText: 'Welcome to the evening news.',
 *   targetDuration: 30,
 * });
 * await video.save();
 * ```
 */

// Models
export {
  type BrandingConfig,
  PersonalityProfile,
  type PersonalityProfileOptions,
  type PersonalityProfileStatus,
} from './personality-profile.js';

export {
  VideoContent,
  type VideoContentOptions,
  type VideoContentStatus,
  type VideoMetadata,
} from './video-content.js';

export {
  type NodeMapping,
  VideoWorkflow,
  type VideoWorkflowOptions,
  type WorkflowType,
} from './video-workflow.js';
