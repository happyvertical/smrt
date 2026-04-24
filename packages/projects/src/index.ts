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

// Export collections
export { IssueCollection } from './collections/Issues';
export { ProjectCollection } from './collections/Projects';
export { PullRequestCollection } from './collections/PullRequests';
export { RepositoryCollection } from './collections/Repositories';

// Export models
export { Comment, type CommentOptions } from './models/Comment';
export { Issue, type IssueOptions } from './models/Issue';
export { Label, type LabelOptions } from './models/Label';
export { Project, type ProjectOptions } from './models/Project';
export { PullRequest, type PullRequestOptions } from './models/PullRequest';
export { Repository, type RepositoryOptions } from './models/Repository';
export { issueIncorporateFeedbackPrompt } from './prompts';

// Export types
export type {
  // From SDK repos
  Branch,
  CreateIssueInput,
  CreatePRInput,
  // SMRT-specific
  IncorporateFeedbackOptions,
  IncorporateFeedbackResult,
  // From SDK projects
  IProject,
  IRepository,
  ItemFilters,
  MergeMethod,
  ProjectConfig,
  ProjectField,
  ProjectFieldOption,
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
  SyncOptions,
  SyncStatus,
  UpdateIssueInput,
  User,
} from './types';

// Export UI metadata
export { PROJECTS_MODULE_META, PROJECTS_UI_SLOTS } from './ui';
