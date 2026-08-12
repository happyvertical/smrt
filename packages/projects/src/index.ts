/**
 * @happyvertical/smrt-projects
 *
 * Provider-agnostic project management models for the SMRT framework.
 *
 * This package provides SMRT-wrapped models for Issues, PullRequests, Repositories,
 * and Projects. It uses @happyvertical/repos and @happyvertical/projects SDK packages
 * for provider-agnostic operations (GitHub, GitLab, etc.).
 *
 * @example
 * ```typescript
 * import {
 *   Repository,
 *   RepositoryCollection,
 *   Issue,
 *   IssueCollection
 * } from '@happyvertical/smrt-projects';
 *
 * // Create a collection
 * const repos = await RepositoryCollection.create({
 *   persistence: { type: 'sql', url: 'projects.db' }
 * });
 *
 * // Get or create a repository
 * const repo = await repos.getOrCreate('happyvertical', 'smrt', {
 *   providerType: 'github',
 *   tokenConfigKey: 'GITHUB_TOKEN'
 * });
 *
 * // Sync repository data
 * await repo.sync();
 *
 * // Discover issues
 * const issues = await repo.getIssues({ state: 'open' });
 *
 * // Incorporate feedback into an issue (Living Spec)
 * const result = await issue.incorporateFeedback({
 *   prompt: 'Synthesize the feedback',
 *   apply: true
 * });
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export { DevelopmentRequestHistoryCollection } from './collections/DevelopmentRequestHistories';
export { DevelopmentRequestCollection } from './collections/DevelopmentRequests';
// Export collections
export { IssueCollection } from './collections/Issues';
export { ProjectIntegrationAuditCollection } from './collections/ProjectIntegrationAudits';
export { ProjectIntegrationCollection } from './collections/ProjectIntegrations';
export { ProjectCollection } from './collections/Projects';
export { PullRequestCollection } from './collections/PullRequests';
export { RepositoryCollection } from './collections/Repositories';
export { ManagedProjectClient } from './managed-client';
// Export models
export { Comment, type CommentOptions } from './models/Comment';
export {
  DevelopmentRequest,
  type DevelopmentRequestOptions,
} from './models/DevelopmentRequest';
export {
  DevelopmentRequestHistory,
  type DevelopmentRequestHistoryOptions,
} from './models/DevelopmentRequestHistory';
export * from './models/delivery-control-plane.js';
export { Issue, type IssueOptions } from './models/Issue';
export { Label, type LabelOptions } from './models/Label';
export { Project, type ProjectOptions } from './models/Project';
export {
  ProjectIntegration,
  type ProjectIntegrationOptions,
} from './models/ProjectIntegration';
export {
  ProjectIntegrationAudit,
  type ProjectIntegrationAuditOptions,
} from './models/ProjectIntegrationAudit';
export { PullRequest, type PullRequestOptions } from './models/PullRequest';
export { Repository, type RepositoryOptions } from './models/Repository';
export * from './models/service-evidence.js';
export type { ProjectBoardMoveIntent } from './project-board-types';
export { issueIncorporateFeedbackPrompt } from './prompts';
export * from './services/index.js';

// Export types
export type {
  AssistanceClassification,
  // From SDK repos
  Branch,
  CreateIssueInput,
  CreatePRInput,
  DeliveryEventType,
  DevelopmentRequestEvidence,
  DevelopmentRequestOrigin,
  DevelopmentRequestStatus,
  DevelopmentRequestTransitionInput,
  DevelopmentRequestType,
  DevelopmentRequestVisibility,
  DevelopmentTriageDecision,
  // SMRT-specific
  IncorporateFeedbackOptions,
  IncorporateFeedbackResult,
  // From SDK projects
  IProject,
  IRepository,
  ItemFilters,
  ManagedAssistanceRequestInput,
  ManagedDevelopmentRequestCreateInput,
  MergeMethod,
  ProjectConfig,
  ProjectField,
  ProjectFieldOption,
  ProjectIntegrationAuditAction,
  ProjectIntegrationCapability,
  ProjectIntegrationStatus,
  ProjectItem,
  ProjectProviderType,
  ProjectStatus,
  RepositoryConfig,
  RepositoryProviderType,
  SDKComment,
  SDKIssue,
  SDKLabel,
  SDKProject,
  SDKPullRequest,
  SDKRepository,
  SearchFilters,
  ServiceEvidence,
  ServiceParticipantKind,
  ServiceTimeEntrySource,
  ServiceTimeEntryStatus,
  SyncOptions,
  SyncStatus,
  UpdateIssueInput,
  User,
} from './types';

// Export UI metadata
export { PROJECTS_MODULE_META, PROJECTS_UI_SLOTS } from './ui';
