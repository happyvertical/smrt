/**
 * @happyvertical/smrt-voice
 *
 * Voice profile management for AI-powered voice synthesis and cloning.
 *
 * This package provides models for managing voice profiles, audio samples,
 * and synthesized voice outputs in the SMRT ecosystem.
 *
 * @example
 * ```typescript
 * import {
 *   VoiceProfile,
 *   VoiceSample,
 *   VoiceOutput,
 * } from '@happyvertical/smrt-voice';
 *
 * // Create a voice profile with voice design
 * const profile = new VoiceProfile({
 *   name: 'News Anchor',
 *   language: 'en-US',
 *   gender: 'male',
 *   designPrompt: 'Warm, authoritative male voice with clear enunciation',
 * });
 * await profile.save();
 *
 * // Or create from a cloned voice sample
 * const clonedProfile = new VoiceProfile({
 *   name: 'Custom Voice',
 *   language: 'en-US',
 *   sampleAssetId: 'asset-123',
 * });
 * await clonedProfile.save();
 * ```
 */

export {
  VoiceOutput,
  type VoiceOutputMetadata,
  type VoiceOutputOptions,
  type WordTiming,
} from './voice-output.js';
// Models
export {
  type VoiceGender,
  VoiceProfile,
  type VoiceProfileOptions,
  type VoiceProfileStatus,
} from './voice-profile.js';
export {
  type SampleQuality,
  VoiceSample,
  type VoiceSampleOptions,
} from './voice-sample.js';
