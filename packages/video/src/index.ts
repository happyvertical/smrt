/**
 * @happyvertical/smrt-video
 *
 * Video content management for AI-powered video production.
 *
 * This package provides models for managing characters, video shots,
 * sequences, compositions, performers, scenes, and ComfyUI workflows.
 *
 * @example
 * ```typescript
 * import {
 *   Character,
 *   VideoShot,
 *   VideoShotCharacter,
 *   VideoSequence,
 *   VideoComposition,
 *   Performer,
 *   Scene,
 * } from '@happyvertical/smrt-video';
 * ```
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// ── Primary exports (current names) ──────────────────────────────────────────

// Character (renamed from PersonalityProfile)
export {
  type BrandingConfig,
  Character,
  type CharacterOptions,
  type CharacterSceneConfig,
  type CharacterStatus,
} from './character.js';
export { CharacterCollection } from './characters.js';
// Other models
export {
  CompositeJob,
  type CompositeJobOptions,
  type CompositeJobStatus,
} from './composite-job.js';
export {
  Performer,
  type PerformerDNA,
  type PerformerOptions,
  type PerformerStatus,
} from './performer.js';
export {
  type AnchorPoint,
  type LightingProfile,
  Scene,
  type SceneOptions,
  type SceneProjection,
  type SceneSourceType,
  type SceneStatus,
  type SceneViewpoint,
} from './scene.js';
export {
  type RenderStatus,
  VideoComposition,
  type VideoCompositionOptions,
} from './video-composition.js';
export { VideoCompositionCollection } from './video-compositions.js';
export {
  type TransitionType,
  VideoSequence,
  type VideoSequenceOptions,
} from './video-sequence.js';
export { VideoSequenceCollection } from './video-sequences.js';
// Video hierarchy
export {
  type VideoMetadata,
  VideoShot,
  type VideoShotOptions,
  type VideoShotStatus,
} from './video-shot.js';
export {
  VideoShotCharacter,
  type VideoShotCharacterOptions,
  type VideoShotCharacterRole,
} from './video-shot-character.js';
export { VideoShotCharacterCollection } from './video-shot-characters.js';
export { VideoShotCollection } from './video-shots.js';

export {
  type NodeMapping,
  VideoWorkflow,
  type VideoWorkflowOptions,
  type WorkflowType,
} from './video-workflow.js';

// ── Owned Asset Models ───────────────────────────────────────────────────────

export {
  CharacterAsset,
  type CharacterAssetOptions,
  type CharacterAssetRole,
} from './character-asset.js';
export { CharacterOwnedAssetCollection } from './character-assets.js';
export {
  CharacterOwnedAsset,
  type CharacterOwnedAssetOptions,
} from './character-owned-asset.js';
export {
  type MediaBundleFileDescriptor,
  type MediaBundleGpsTrackPoint,
  type MediaBundleInspectionLike,
  type MediaBundleNormalizedMetadata,
  type MediaBundleSupportFileInspection,
  type MediaSupportFileVisibility,
  type PersistMediaBundleAssetInput,
  type PersistMediaBundleAssociationInput,
  type PersistMediaBundleInspectionOptions,
  type PersistMediaBundleInspectionResult,
  type PersistMediaBundleMetadataArtifactInput,
  persistMediaBundleInspection,
  type SmrtMediaBundlePersistenceAdapter,
} from './media-bundle-persistence.js';
export {
  PerformerAsset,
  type PerformerAssetOptions,
  type PerformerAssetRole,
} from './performer-asset.js';
export { PerformerOwnedAssetCollection } from './performer-assets.js';
export {
  PerformerOwnedAsset,
  type PerformerOwnedAssetOptions,
} from './performer-owned-asset.js';
export {
  SceneAsset,
  type SceneAssetOptions,
  type SceneAssetRole,
} from './scene-asset.js';
export { SceneOwnedAssetCollection } from './scene-assets.js';
export {
  SceneOwnedAsset,
  type SceneOwnedAssetOptions,
} from './scene-owned-asset.js';
export {
  VideoCompositionAsset,
  type VideoCompositionAssetOptions,
  type VideoCompositionAssetRole,
} from './video-composition-asset.js';
export {
  VideoSequenceAsset,
  type VideoSequenceAssetOptions,
  type VideoSequenceAssetRole,
} from './video-sequence-asset.js';
export {
  VideoShotAsset,
  type VideoShotAssetOptions,
  type VideoShotAssetRole,
} from './video-shot-asset.js';

// ── Deprecated re-exports (backwards compatibility) ──────────────────────────

/** @deprecated Use Character instead */
/** @deprecated Use CharacterOptions instead */
/** @deprecated Use CharacterStatus instead */
export {
  Character as PersonalityProfile,
  type CharacterOptions as PersonalityProfileOptions,
  type CharacterStatus as PersonalityProfileStatus,
} from './character.js';
/** @deprecated Use VideoShot instead */
/** @deprecated Use VideoShotOptions instead */
/** @deprecated Use VideoShotStatus instead */
export {
  VideoShot as VideoContent,
  type VideoShotOptions as VideoContentOptions,
  type VideoShotStatus as VideoContentStatus,
} from './video-shot.js';
