/**
 * @packageDocumentation
 * STI content types (Article, ContentDocument, Mirror) with thumbnail generation
 * strategies, content-owned asset relationships, and markdown serialization
 * utilities.
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export type {
  AssetAssociable,
  MetadataAccessor,
} from './asset-associable';
export { isAssetAssociable, isMetadataAccessor } from './asset-associable';
export type { ContentBodyFormat, ContentBodyImage } from './body-format';
export {
  bodyToEditorHtml,
  DEFAULT_CONTENT_BODY_FORMAT,
  editorHtmlToBody,
  extractBodyImages,
  htmlToMarkdown,
  renderMarkdownToHtml,
  resolveBodyFormat,
  sanitizeHtml,
  stripHtml,
} from './body-format';
export type { ContentOptions } from './content';
export { Content } from './content';
export type { ContentAssetOptions } from './content-asset';
export { ContentAsset } from './content-asset';
export { ContentAssetCollection } from './content-assets';
export type {
  ContentChatAIConfig,
  ContentChatCollectionLike,
  ContentChatSessionInput,
  CreateContentChatThreadInput,
  ListContentChatThreadMessagesInput,
  ResolveContentChatAIInput,
  ResolvedContentChatAI,
  SendContentChatThreadMessageInput,
} from './content-chat-handlers';
export {
  contentChatMessageToJSON,
  contentChatSessionIsAuthorized,
  contentChatSessionKey,
  contentChatSessionMatchesContent,
  createContentEditorChatThread,
  getOrCreateContentEditorChatSession,
  listContentEditorChatThreadMessages,
  resolveDefaultContentChatAI,
  sendContentEditorChatThreadMessage,
  serializeContentChatMessageForUI,
} from './content-chat-handlers';
export {
  contentEditorInteractionPrompt,
  contentEditorSessionPrompt,
} from './content-chat-prompts';
export type {
  ContentChatAISelection,
  ContentEditorInteractionInput,
} from './content-chat-session';
export {
  buildContentChatModelUpdates,
  buildContentEditorInteractionVariables,
  buildContentEditorSessionContext,
  getContentChatAISelection,
  inferProviderFromModel,
  resolveContentChatModelSelection,
} from './content-chat-session';
export type {
  AppendContentContributionRevisionOptions,
  ApproveContentContributionOptions,
  ContentContributionAttachmentInput,
  ContentContributionOptions,
  PromoteContentContributionOptions,
  RejectContentContributionOptions,
  RequestChangesContentContributionOptions,
  WithdrawContentContributionOptions,
} from './content-contribution';
export { ContentContribution } from './content-contribution';
export type { ContentContributionAttachmentOptions } from './content-contribution-attachment';
export { ContentContributionAttachment } from './content-contribution-attachment';
export { ContentContributionAttachmentCollection } from './content-contribution-attachments';
export type {
  ContentContributionChannel,
  ContentContributionConfig,
  ContentContributionIntakeDecision,
  ContentContributionIntakeRules,
  ContentContributionPromotionMapping,
  ContentContributionStatus,
  ContentContributionTypeDefinition,
  ContentContributorTrustLevel,
  EvaluateContributionIntakeOptions,
  EvaluateContributionIntakeResult,
  PersistedContentContributionTypeRecord,
  ResolvedContentContributionType,
} from './content-contribution-config';
export {
  configureContentContributions,
  evaluateContributionIntake,
  getContentContributionConfig,
  getContentContributionTypeConfigState,
  getEffectiveContentContributionConfig,
  hasStaticContentContributionType,
  loadPersistedContentContributionTypes,
  resetContentContributionConfig,
  resolveEffectiveContentContributionType,
} from './content-contribution-config';
export type { ContentContributionRevisionOptions } from './content-contribution-revision';
export { ContentContributionRevision } from './content-contribution-revision';
export { ContentContributionRevisionCollection } from './content-contribution-revisions';
export type { ContentContributionTypeOptions } from './content-contribution-type';
export { ContentContributionType } from './content-contribution-type';
export { ContentContributionTypeCollection } from './content-contribution-types';
export type {
  IngestEmailContentContributionOptions,
  SubmitWebContentContributionOptions,
} from './content-contributions';
export { ContentContributions } from './content-contributions';
export type { ContentContributorOptions } from './content-contributor';
export { ContentContributor } from './content-contributor';
export { ContentContributorCollection } from './content-contributors';
export type { ContentCorrectionOptions } from './content-correction';
export { ContentCorrection } from './content-correction';
export { ContentCorrectionCollection } from './content-corrections';
export type {
  ContentEditorAssistantActions,
  ContentEditorAssistantChatProps,
  ContentEditorAssistantContext,
  ContentEditorAssistantContextChange,
  ContentEditorAssistantContextData,
  ContentEditorAssistantEditorKind,
  ContentEditorAssistantFactSummary,
  ContentEditorAssistantFields,
  ContentEditorAssistantFieldUpdateAllowList,
  ContentEditorAssistantGovernanceSummary,
  ContentEditorAssistantRegistration,
  CreateContentEditorAssistantContextInput,
} from './content-editor-assistant';
export {
  contentEditorAssistantContextToChatProps,
  createContentEditorAssistantContext,
  sanitizeContentEditorAssistantFieldUpdates,
} from './content-editor-assistant';
export type {
  ContentFeedFormat,
  ParsedContentFeed,
  ParsedContentFeedItem,
} from './content-feed-parser';
export { parseContentFeed } from './content-feed-parser';
export type {
  ContentFeedSourceOptions,
  ContentFeedSourceStatus,
} from './content-feed-source';
export { ContentFeedSource } from './content-feed-source';
export type { ContentFeedSourceCollectionOptions } from './content-feed-sources';
export { ContentFeedSourceCollection } from './content-feed-sources';
export type {
  ContentFeedSyncOptions,
  ContentFeedSyncResult,
} from './content-feed-sync';
export { syncContentFeedSource } from './content-feed-sync';
export type {
  ContentCorrectionStatus,
  ContentCorrectionType,
  ContentGovernanceAssignmentDefinition,
  ContentGovernanceConfig,
  ContentGovernanceProfileDefinition,
  ContentGovernanceState,
  ContentReviewFinding,
  ContentReviewKind,
  ContentReviewPolicyDefinition,
  ContentReviewProfileEvaluation,
  ContentReviewProfileEvaluationItem,
  ContentReviewRequirement,
  ContentReviewResult,
  ContentReviewSeverity,
  ContentReviewStatus,
  ContentVersionKind,
  CreateContentVersionOptions,
  IssueContentCorrectionOptions,
  ResolvedContentGovernance,
  RunContentReviewOptions,
} from './content-governance';
export {
  buildContentGovernanceAssignmentKey,
  buildContentReviewPrompt,
  configureContentGovernance,
  getAcceptedContentReviewStatuses,
  getContentGovernanceConfig,
  getContentReviewKind,
  getContentReviewPolicies,
  getContentReviewPolicy,
  getContentReviewProfile,
  getContentReviewProfileKeys,
  getContentReviewRequirements,
  getEffectiveContentGovernanceConfig,
  hasStaticContentGovernancePolicy,
  hasStaticContentGovernanceProfile,
  parseContentReviewResponse,
  resetContentGovernanceConfig,
  resolveConfiguredContentGovernance,
  resolveEffectiveContentGovernance,
} from './content-governance';
export type { ContentGovernanceAssignmentOptions } from './content-governance-assignment';
export { ContentGovernanceAssignment } from './content-governance-assignment';
export { ContentGovernanceAssignmentCollection } from './content-governance-assignments';
export { ContentGovernancePolicyCollection } from './content-governance-policies';
export type { ContentGovernancePolicyOptions } from './content-governance-policy';
export { ContentGovernancePolicy } from './content-governance-policy';
export type { ContentGovernanceProfileOptions } from './content-governance-profile';
export { ContentGovernanceProfile } from './content-governance-profile';
export { ContentGovernanceProfileCollection } from './content-governance-profiles';
export {
  promptMessageOptions,
  smrtContentApplyCorrectionPrompt,
  smrtContentReviewPrompt,
  smrtContentThumbnailAIGeneratePrompt,
} from './content-prompts';
export type { ContentReferenceOptions } from './content-reference';
export { ContentReference } from './content-reference';
export type { ContentReferencesOptions } from './content-references';
export { ContentReferences } from './content-references';
export type { ContentReviewOptions } from './content-review';
export { ContentReview } from './content-review';
export { ContentReviewCollection } from './content-reviews';
export type {
  ContentTransparencyData,
  ContentTransparencyFact,
  ContentTransparencyGeneration,
  ContentTransparencyPublicationVersion,
  ContentTransparencyReference,
  ContentTransparencySource,
  ContentTransparencyVersionHistoryItem,
} from './content-transparency';
export { normalizeContentTransparency } from './content-transparency';
export type { MirrorOptions } from './content-types';
// Content subclasses (STI)
export {
  Article,
  ContentDocument,
  Mirror,
} from './content-types';
export type { ContentVersionOptions } from './content-version';
export { ContentVersion } from './content-version';
export { ContentVersionCollection } from './content-versions';
export type { ContentsOptions } from './contents';
export { Contents } from './contents';
export type {
  ContentPublishReadinessState,
  EvaluateContentPublishReadinessOptions,
  PublishReadinessProfile,
  PublishReadinessRequirement,
} from './publish-readiness';
export { evaluateContentPublishReadiness } from './publish-readiness';
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
