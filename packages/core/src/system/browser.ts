/**
 * Browser-safe subset of the system-table surface (#2838).
 *
 * Everything `system/index.ts` exports except the registry snapshot, which
 * sanitizes filesystem paths with `node:path` and exists for the Node-side
 * dev plane (smrt-dev-mcp). `browser.ts` re-exports this module so a page
 * bundle never reaches `node:path`; `system/index.ts` re-exports it too, so
 * the Node entry's surface is unchanged.
 */

// `SMRT_SCHEMA_VERSION` is the one schema.ts value consumers legitimately
// need outside this package — e.g. to assert against the version
// `ensureSystemTables()` stamps into `_smrt_migrations` — without hardcoding
// a literal that goes stale on every bump (#3080).
// Prompt-run observability: evaluations and the ai:usage report (#4751),
// fusion run records (#4753), prompt comparison and template history (#4782).
export * from './ai-prompt-compare.js';
// The AI run lifecycle, events, trajectories and accounting (#5005).
export * from './ai-run-accounting.js';
export * from './ai-run-calls.js';
export * from './ai-run-entry.js';
export * from './ai-run-events.js';
export * from './ai-run-lifecycle.js';
export {
  AI_RUN_FINAL_STATUSES,
  AI_RUN_FRAMEWORK_TYPES,
  AI_RUN_LIFECYCLE_STATUSES,
  AI_RUN_LIMIT_REASONS,
  AI_RUN_STOP_REASONS,
  AI_RUN_TX_ATTEMPTS,
  AiCallLimitError,
  type AiRunBudget,
  type AiRunBudgetLimit,
  AiRunCheckpointConflictError,
  type AiRunClaimFence,
  AiRunClaimLostError,
  type AiRunEngine,
  AiRunError,
  type AiRunLimitStopReason,
  AiRunNotFoundError,
  AiRunResumeRefusedError,
  type AiRunRow,
  type AiRunStatus,
  type AiRunStopDetail,
  AiRunStoppedError,
  type AiRunStopReason,
  AiRunTrackingDisabledError,
  AiRunTransitionError,
  type AiRunTx,
  type AiRunTxOptions,
  aiRunActiveTime,
  getAiRun,
  isAiRunFinal,
  isValidAiRunType,
  withAiRunTransaction,
} from './ai-run-model.js';
export * from './ai-run-policy.js';
export * from './ai-runs.js';
export * from './ai-transcripts.js';
export * from './ai-usage-observability.js';
export {
  ensureSystemTables,
  runSerializedAgainstSystemTableBootstrap,
} from './bootstrap.js';
export * from './compatibility.js';
export * from './diagnostics.js';
export * from './retention.js';
export { SMRT_SCHEMA_VERSION } from './schema.js';
export * from './types.js';
