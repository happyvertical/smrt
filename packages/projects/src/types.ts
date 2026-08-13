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

/**
 * Managed application capability keys for project integrations.
 */
export type ProjectIntegrationCapability =
  | 'requests:create'
  | 'requests:read-own'
  | 'delivery:write'
  | 'delivery:read'
  | 'projects:write'
  | 'previews:approve'
  | 'assistance:create'
  | (string & {});

/**
 * Provisioned managed-application integration lifecycle.
 */
export type ProjectIntegrationStatus = 'active' | 'revoked';

/**
 * Audit events emitted for managed-application integrations.
 */
export type ProjectIntegrationAuditAction = 'created' | 'rotated' | 'revoked';

/**
 * Supported development request categories. Open string union so apps can add
 * narrower taxonomy without waiting for a package release.
 */
export type DevelopmentRequestType = 'bug' | 'feature' | 'task' | (string & {});

/**
 * Request visibility as shown back to the managed application's user.
 */
export type DevelopmentRequestVisibility =
  | 'requester'
  | 'workspace'
  | 'public'
  | 'project_team'
  | 'internal';

/**
 * Request origin marker.
 */
export type DevelopmentRequestOrigin = 'managed-app' | (string & {});

/**
 * Request lifecycle status.
 */
export type DevelopmentRequestStatus =
  | 'submitted'
  | 'triaged'
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'declined';

/**
 * One evidence attachment linked from a request.
 */
export interface DevelopmentRequestEvidence {
  url: string;
  label?: string;
}

/**
 * Input accepted by the managed integration server client when creating a
 * request on behalf of an app-scoped requester.
 */
export interface ManagedDevelopmentRequestCreateInput {
  requesterId: string;
  participantId?: string;
  type: DevelopmentRequestType;
  description: string;
  evidence?: DevelopmentRequestEvidence[];
  visibility?: DevelopmentRequestVisibility;
  origin?: DevelopmentRequestOrigin;
  discussion?: string;
}

/**
 * Actor metadata captured for a request lifecycle transition.
 */
export interface DevelopmentRequestTransitionInput {
  status: DevelopmentRequestStatus;
  actorType: 'integration' | 'participant' | 'system';
  actorId?: string;
  note?: string;
}

export type DevelopmentTriageDecision =
  | 'accept'
  | 'decline'
  | 'merge'
  | 'split';

export type DeliveryEventType =
  | 'work_linked'
  | 'branch'
  | 'pull_request'
  | 'ci'
  | 'preview'
  | 'approval'
  | 'deployment'
  | 'completed'
  | 'rejected';

export type AssistanceClassification =
  | 'unclassified'
  | 'support'
  | 'development'
  | 'both';

export type ServiceTimeEntrySource = 'timer' | 'manual' | 'import' | 'agent';
export type ServiceTimeEntryStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'corrected';
export type ServiceParticipantKind = 'human' | 'agent';

export interface ServiceEvidence {
  kind: string;
  ref?: string;
  summary?: string;
  capturedAt?: string;
  [key: string]: unknown;
}

export interface ManagedAssistanceRequestInput {
  requesterId: string;
  subject: string;
  conversation: Record<string, unknown>[];
  applicationContext?: Record<string, unknown>;
  evidence?: DevelopmentRequestEvidence[];
}
