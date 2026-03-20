/**
 * @packageDocumentation
 * STI content types (Article, ContentDocument, Mirror) with thumbnail generation
 * strategies, asset associations, and markdown serialization utilities.
 */

export type { ContentOptions } from './content';
export { Content } from './content';
export type { ContentCorrectionOptions } from './content-correction';
export { ContentCorrection } from './content-correction';
export { ContentCorrectionCollection } from './content-corrections';
export type {
  ContentCorrectionStatus,
  ContentCorrectionType,
  ContentGovernanceConfig,
  ContentReviewFinding,
  ContentReviewKind,
  ContentReviewPolicy,
  ContentReviewProfileEvaluation,
  ContentReviewProfileEvaluationItem,
  ContentReviewRequirement,
  ContentReviewResult,
  ContentReviewSeverity,
  ContentReviewStatus,
  ContentVersionKind,
  CreateContentVersionOptions,
  IssueContentCorrectionOptions,
  RunContentReviewOptions,
} from './content-governance';
export {
  buildContentReviewPrompt,
  configureContentGovernance,
  DEFAULT_SAFETY_PROMPT,
  getAcceptedContentReviewStatuses,
  getContentGovernanceConfig,
  getContentReviewKind,
  getContentReviewPolicy,
  getContentReviewProfile,
  getContentReviewProfileKeys,
  getContentReviewRequirements,
  isFactualContentEnabled,
  parseContentReviewResponse,
  resetContentGovernanceConfig,
} from './content-governance';
export type { ContentReferenceOptions } from './content-reference';
export { ContentReference } from './content-reference';
export type { ContentReferencesOptions } from './content-references';
export { ContentReferences } from './content-references';
export type { ContentReviewOptions } from './content-review';
export { ContentReview } from './content-review';
export { ContentReviewCollection } from './content-reviews';
// Content subclasses (STI)
export {
  Article,
  ContentDocument,
  FactualContent,
  Mirror,
} from './content-types';
export type { ContentVersionOptions } from './content-version';
export { ContentVersion } from './content-version';
export { ContentVersionCollection } from './content-versions';
export type { ContentsOptions } from './contents';
export { Contents } from './contents';
// Thumbnail generation
export {
  type AIGenerateThumbnailOptions,
  type HeadlineCardThumbnailOptions,
  type StaticMapThumbnailOptions,
  ThumbnailGenerator,
  type ThumbnailOptions,
  type ThumbnailStrategy,
} from './thumbnail-generator';
export { contentToString, stringToContent } from './utils';
