/**
 * @happyvertical/smrt-projects - Type definitions
 *
 * Re-exports SDK types and defines SMRT-specific types
 */

// Re-export SDK types from @happyvertical/projects
export type {
  Field as ProjectField,
  FieldOption as ProjectFieldOption,
  IProject,
  ItemFilters,
  Project as SDKProject,
  ProjectConfig,
  ProjectItem,
  Status as ProjectStatus,
} from '@happyvertical/projects';
// Re-export SDK types from @happyvertical/repos
export type {
  Branch,
  Comment as SDKComment,
  CreateIssueInput,
  CreatePRInput,
  IRepository,
  Issue as SDKIssue,
  Label as SDKLabel,
  MergeMethod,
  PullRequest as SDKPullRequest,
  Repository as SDKRepository,
  RepositoryConfig,
  SearchFilters,
  UpdateIssueInput,
  User,
} from '@happyvertical/repos';

/**
 * Provider types supported by smrt-projects
 */
export type RepositoryProviderType =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure';
export type ProjectProviderType = 'github' | 'jira' | 'linear' | 'zenhub';

/**
 * Result of incorporateFeedback operation
 */
export interface IncorporateFeedbackResult {
  /** The synthesized body text */
  synthesized: string;
  /** Whether the changes were applied to the issue */
  applied: boolean;
  /** Number of comments that were analyzed */
  commentsAnalyzed: number;
  /** Previous body (before update) */
  previousBody?: string;
}

/**
 * Options for incorporateFeedback method
 */
export interface IncorporateFeedbackOptions {
  /** Custom prompt for AI synthesis */
  prompt?: string;
  /** Whether to apply changes immediately (default: false for preview) */
  apply?: boolean;
  /** Include comments since this date */
  since?: Date;
}

/**
 * Options for sync operations
 */
export interface SyncOptions {
  /** Force sync even if recently synced */
  force?: boolean;
  /** Include comments in sync */
  includeComments?: boolean;
}

/**
 * Sync status tracking
 */
export interface SyncStatus {
  lastSyncedAt: Date | null;
  syncError?: string;
  syncedFields: string[];
}
