import type {
  InferenceMode,
  InferenceUnavailableReason,
} from '@happyvertical/smrt-core';

/**
 * Agent status type
 */
export type AgentStatusType =
  | 'idle'
  | 'initializing'
  | 'running'
  | 'error'
  | 'skipped'
  | 'shutdown';

/**
 * The outcome of one `Agent.execute()` (#4757). `skipped` means AI was
 * unavailable (`AI_UNAVAILABLE`): `reason` and `mode` say why; nothing ran.
 */
export interface AgentRunRecord {
  status: 'completed' | 'skipped' | 'error';
  startedAt: Date;
  finishedAt: Date;
  /** `skipped` only. */
  reason?: InferenceUnavailableReason;
  /** `skipped` only. */
  mode?: InferenceMode;
  /** `error` only: the error message. */
  error?: string;
}
