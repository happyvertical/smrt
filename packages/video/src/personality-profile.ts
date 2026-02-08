/**
 * PersonalityProfile - DEPRECATED
 *
 * Use Character instead. This module re-exports Character as PersonalityProfile
 * for backwards compatibility.
 *
 * @deprecated Use {@link Character} from './character.js' instead.
 */

export {
  type BrandingConfig,
  Character as PersonalityProfile,
  type CharacterOptions as PersonalityProfileOptions,
  type CharacterSceneConfig,
  type CharacterStatus as PersonalityProfileStatus,
} from './character.js';
