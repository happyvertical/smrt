/**
 * Types for background job UI components
 */
import type { Snippet } from 'svelte';

// Job status type (mirrors smrt-jobs)
export type JobStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

// Job priority type
export type JobPriority = 'low' | 'normal' | 'high' | 'critical';

// Timeout behavior type
export type TimeoutBehavior = 'fail' | 'kill' | 'warn';

/**
 * Job data structure for display
 */
export interface JobData {
  id: string;
  queue: string;
  objectType: string;
  objectId: string | null;
  method: string;
  args: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  timeout: number;
  timeoutBehavior: TimeoutBehavior;
  runAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  lastError: string | null;
  resultPointer: string | null;
  workerId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Job statistics for dashboard
 */
export interface JobStats {
  total: number;
  pending: number;
  ready: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  avgDuration: number | null;
  successRate: number | null;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  name: string;
  pending: number;
  running: number;
  completed24h: number;
  failed24h: number;
  avgDuration: number | null;
}

/**
 * Filter options for job list
 */
export interface JobFilter {
  status?: JobStatus | JobStatus[] | 'all';
  queue?: string;
  objectType?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Sort options for job list
 */
export interface JobSort {
  field: 'createdAt' | 'runAt' | 'priority' | 'status';
  direction: 'asc' | 'desc';
}

/**
 * JobList component props
 */
export interface JobListProps {
  /** Jobs to display */
  jobs: JobData[];
  /** Loading state */
  loading?: boolean;
  /** Filter state */
  filter?: JobFilter;
  /** Sort state */
  sort?: JobSort;
  /** Selectable rows */
  selectable?: boolean;
  /** Selected job IDs */
  selected?: Set<string>;
  /** Callback when selection changes */
  onSelectionChange?: (selected: Set<string>) => void;
  /** Callback when job is clicked */
  onJobClick?: (job: JobData) => void;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Empty state snippet */
  empty?: Snippet;
}

/**
 * JobDetail component props
 */
export interface JobDetailProps {
  /** Job to display */
  job: JobData;
  /** Show result data */
  showResult?: boolean;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Callback when delete is clicked */
  onDelete?: (job: JobData) => void;
}

/**
 * JobStats component props
 */
export interface JobStatsProps {
  /** Statistics data */
  stats: JobStats;
  /** Queue breakdown */
  queues?: QueueStats[];
  /** Loading state */
  loading?: boolean;
  /** Auto-refresh interval (ms, 0 = disabled) */
  refreshInterval?: number;
}

/**
 * JobActions component props
 */
export interface JobActionsProps {
  /** Job to perform actions on */
  job: JobData;
  /** Show retry button */
  showRetry?: boolean;
  /** Show cancel button */
  showCancel?: boolean;
  /** Show delete button */
  showDelete?: boolean;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Callback when delete is clicked */
  onDelete?: (job: JobData) => void;
  /** Compact mode */
  compact?: boolean;
}

/**
 * JobDashboard component props
 */
export interface JobDashboardProps {
  /** Statistics data */
  stats: JobStats;
  /** Queue breakdown */
  queues?: QueueStats[];
  /** Recent jobs */
  recentJobs?: JobData[];
  /** Failed jobs */
  failedJobs?: JobData[];
  /** Loading state */
  loading?: boolean;
  /** Callback when job is clicked */
  onJobClick?: (job: JobData) => void;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
}

/**
 * Helper function to get status variant for Badge
 */
export function getStatusVariant(
  status: JobStatus,
): 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' {
  switch (status) {
    case 'pending':
      return 'default';
    case 'ready':
      return 'info';
    case 'running':
      return 'primary';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    default:
      return 'default';
  }
}

/**
 * Helper function to format duration
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Helper function to format relative time
 */
export function formatRelativeTime(date: Date | string | null): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 0) {
    // Future
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return 'in a moment';
    if (absDiff < 3600000) return `in ${Math.round(absDiff / 60000)}m`;
    if (absDiff < 86400000) return `in ${Math.round(absDiff / 3600000)}h`;
    return `in ${Math.round(absDiff / 86400000)}d`;
  }

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

/**
 * Helper function to get priority label
 */
export function getPriorityLabel(priority: number): string {
  if (priority >= 90) return 'Critical';
  if (priority >= 75) return 'High';
  if (priority >= 25) return 'Normal';
  return 'Low';
}

/**
 * Helper function to get priority color class
 */
export function getPriorityClass(priority: number): string {
  if (priority >= 90) return 'priority-critical';
  if (priority >= 75) return 'priority-high';
  if (priority >= 25) return 'priority-normal';
  return 'priority-low';
}
