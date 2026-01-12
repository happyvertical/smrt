/**
 * Types for agent schedule UI components
 */
import type { Snippet } from 'svelte';

// Schedule status type (mirrors smrt-agents)
export type ScheduleStatus = 'active' | 'paused' | 'disabled' | 'error';

// Run status type
export type RunStatus = 'success' | 'failed';

/**
 * Agent schedule data structure for display
 */
export interface AgentScheduleData {
  id: string;
  agentType: string;
  agentId: string | null;
  agentConfig: Record<string, unknown>;
  cron: string;
  timezone: string;
  enabled: boolean;
  status: ScheduleStatus;
  lastRun: Date | string | null;
  nextRun: Date | string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  maxConcurrent: number;
  runningCount: number;
  timeout: number;
  method: string;
  methodArgs: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Agent run history entry
 */
export interface AgentRunHistoryEntry {
  id: string;
  scheduleId: string;
  agentType: string;
  status: RunStatus;
  startedAt: Date | string;
  completedAt: Date | string | null;
  duration: number | null;
  error: string | null;
}

/**
 * Schedule form data for create/edit
 */
export interface ScheduleFormData {
  agentType: string;
  agentId?: string;
  agentConfig?: Record<string, unknown>;
  cron: string;
  timezone?: string;
  enabled?: boolean;
  maxConcurrent?: number;
  timeout?: number;
  method?: string;
  methodArgs?: Record<string, unknown>;
}

/**
 * AgentScheduleList component props
 */
export interface AgentScheduleListProps {
  /** Schedules to display */
  schedules: AgentScheduleData[];
  /** Loading state */
  loading?: boolean;
  /** Callback when schedule is clicked */
  onScheduleClick?: (schedule: AgentScheduleData) => void;
  /** Callback when enable is clicked */
  onEnable?: (schedule: AgentScheduleData) => void;
  /** Callback when disable is clicked */
  onDisable?: (schedule: AgentScheduleData) => void;
  /** Callback when delete is clicked */
  onDelete?: (schedule: AgentScheduleData) => void;
  /** Callback when run now is clicked */
  onRunNow?: (schedule: AgentScheduleData) => void;
  /** Empty state snippet */
  empty?: Snippet;
}

/**
 * AgentScheduleForm component props
 */
export interface AgentScheduleFormProps {
  /** Initial form data (for editing) */
  initialData?: Partial<ScheduleFormData>;
  /** Available agent types */
  agentTypes?: string[];
  /** Submit callback */
  onSubmit?: (data: ScheduleFormData) => void;
  /** Cancel callback */
  onCancel?: () => void;
  /** Loading state */
  loading?: boolean;
  /** Edit mode */
  editMode?: boolean;
}

/**
 * AgentRunHistory component props
 */
export interface AgentRunHistoryProps {
  /** Run history entries */
  history: AgentRunHistoryEntry[];
  /** Loading state */
  loading?: boolean;
  /** Callback when entry is clicked */
  onEntryClick?: (entry: AgentRunHistoryEntry) => void;
  /** Empty state snippet */
  empty?: Snippet;
}

/**
 * AgentDashboard component props
 */
export interface AgentDashboardProps {
  /** All schedules */
  schedules: AgentScheduleData[];
  /** Recent run history */
  recentHistory?: AgentRunHistoryEntry[];
  /** Loading state */
  loading?: boolean;
  /** Callbacks */
  onScheduleClick?: (schedule: AgentScheduleData) => void;
  onEnable?: (schedule: AgentScheduleData) => void;
  onDisable?: (schedule: AgentScheduleData) => void;
  onDelete?: (schedule: AgentScheduleData) => void;
  onRunNow?: (schedule: AgentScheduleData) => void;
  onCreateSchedule?: () => void;
}

/**
 * Helper function to get status variant for Badge
 */
export function getScheduleStatusVariant(
  status: ScheduleStatus,
): 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' {
  switch (status) {
    case 'active':
      return 'success';
    case 'paused':
      return 'warning';
    case 'disabled':
      return 'default';
    case 'error':
      return 'error';
    default:
      return 'default';
  }
}

/**
 * Helper function to get run status variant
 */
export function getRunStatusVariant(
  status: RunStatus | null,
): 'default' | 'success' | 'error' {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'error';
  return 'default';
}

/**
 * Helper function to format cron expression for display
 */
export function formatCronExpression(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (
    minute === '0' &&
    hour !== '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `Daily at ${hour}:00`;
  }

  if (
    minute !== '*' &&
    hour !== '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '0'
  ) {
    return `Weekly on Sunday at ${hour}:${minute.padStart(2, '0')}`;
  }

  if (
    minute !== '*' &&
    hour !== '*' &&
    dayOfMonth === '1' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `Monthly on 1st at ${hour}:${minute.padStart(2, '0')}`;
  }

  if (minute.includes('/')) {
    const interval = minute.split('/')[1];
    return `Every ${interval} minutes`;
  }

  if (hour.includes('/')) {
    const interval = hour.split('/')[1];
    return `Every ${interval} hours`;
  }

  return cron;
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
 * Calculate success rate
 */
export function calculateSuccessRate(
  schedule: AgentScheduleData,
): number | null {
  if (schedule.runCount === 0) return null;
  return schedule.successCount / schedule.runCount;
}
