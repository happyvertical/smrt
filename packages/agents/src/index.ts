/**
 * @have/agents - Agent framework for building autonomous actors
 *
 * Provides a base Agent class that extends SmrtObject with:
 * - Status tracking
 * - Configuration management integration
 * - Structured logging
 * - Lifecycle hooks
 * - Automatic signal handling for graceful shutdown
 * - Interest-based object discovery via interesting() method
 *
 * Agents can define their own properties for state management - since they extend
 * SmrtObject, any properties defined will be automatically persisted to the database.
 *
 * @example
 * ```typescript
 * import { Agent, type AgentOptions } from '@have/agents';
 * import { getModuleConfig } from '@have/config';
 * import { smrt } from '@happyvertical/smrt-core';
 *
 * @smrt()
 * class MyAgent extends Agent {
 *   protected config = getModuleConfig('my-agent', {
 *     cronSchedule: '0 2 * * *',
 *     maxRetries: 3
 *   });
 *
 *   // Define your own state properties (automatically persisted)
 *   itemsProcessed: number = 0;
 *
 *   constructor(options: AgentOptions = {}) {
 *     super({
 *       ...options,
 *       interests: {
 *         filter: { status: 'active' },
 *         objects: {
 *           Meeting: { sort: 'scheduled_at DESC', limit: 10 },
 *           Document: { filter: { 'type in': ['agenda', 'minutes'] } }
 *         }
 *       }
 *     });
 *   }
 *
 *   async validate(): Promise<void> {
 *     if (!this.config.cronSchedule) {
 *       throw new Error('cronSchedule is required');
 *     }
 *   }
 *
 *   async run(): Promise<void> {
 *     // Query objects the agent is interested in
 *     const items = await this.interesting();
 *     for (const { type, data } of items) {
 *       console.log(`Processing ${type}: ${data.id}`);
 *     }
 *     this.itemsProcessed = items.length;
 *     await this.save(); // Persist state
 *   }
 * }
 *
 * const agent = new MyAgent({ name: 'my-agent' });
 * await agent.execute();
 * ```
 *
 * @module @have/agents
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Re-export core lazy-config primitives for discoverability — agents are the
// primary use case for `agent_config` snapshot resolution (issue #1161).
export type {
  ConfigResolver,
  LazyConfigSentinel,
  ResolveLazyConfigOptions,
} from '@happyvertical/smrt-core';
export {
  getClassConfigResolvers,
  getConfigResolver,
  isLazyConfigSentinel,
  listConfigResolvers,
  registerConfigResolver,
  resetConfigResolvers,
  resolveLazyConfig,
  unregisterConfigResolver,
} from '@happyvertical/smrt-core';
export { Agent, type AgentOptions } from './agent.js';
export {
  type AgentAIOptions,
  type AgentAISecretFallback,
  resolveAgentAIOptions,
} from './ai-config.js';
export { AgentConfig, AgentConfigCollection } from './config.js';
// Principal-bound data discovery, schema inspection, and bounded reads (#2447).
export {
  createDataSurfaceQueryFingerprint,
  createDataSurfaceTools,
  DATA_DISCOVER_FUNCTION_NAME,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_FUNCTION_NAME,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_FUNCTION_NAME,
  DATA_QUERY_TOOL_SLUG,
  type DataSurfaceAuditEntry,
  type DataSurfaceAuditSink,
  DataSurfaceDeadlineError,
  type DataSurfaceDefinition,
  DataSurfaceDeniedError,
  type DataSurfaceExecutionContext,
  type DataSurfaceExecutor,
  type DataSurfaceExecutorResult,
  type DataSurfaceFailureEntry,
  type DataSurfaceFailureSink,
  type DataSurfaceField,
  type DataSurfaceFieldMetadata,
  type DataSurfacePrincipal,
  DataSurfaceQueryError,
  DataSurfaceRequestError,
  DataSurfaceResultOrderError,
  type DataSurfaceSchema,
  type DataSurfaceToolsOptions,
  DEFAULT_DATA_SURFACE_DEADLINE_MS,
  MAX_DATA_SURFACE_DEADLINE_MS,
} from './data-surface.js';
// Principal delegation for agent orchestration (#1892): the immutable-principal,
// bounded-depth delegation envelope.
export {
  assertPrincipalNotWidened,
  assertWithinDelegationDepth,
  DelegationDepthExceededError,
  type DelegationEnvelope,
  type DeriveDelegationEnvelopeOptions,
  deriveDelegationEnvelope,
  MAX_DELEGATION_DEPTH,
  PrincipalWideningError,
  type RequestedPrincipal,
  type RootDelegationEnvelopeOptions,
  rootDelegationEnvelope,
} from './delegation.js';
export {
  type ExecuteAsPrincipalOptions,
  executeAsPrincipal,
  type PrincipalAuditEntry,
  type PrincipalAuditSink,
  type PrincipalBinding,
  type PrincipalRun,
  PrincipalToolNotAllowedError,
} from './execute-as-principal.js';
// Per-instance dispatch subscriber composition (#1890). Exported so
// `@happyvertical/smrt-personas` can derive the same identity for a persona
// without reconstructing an agent.
export { instanceScopedSubscriber } from './identity.js';
export type {
  AgentWithInterestsOptions,
  AsyncQualifierFn,
  InterestFilter,
  InterestHandlerFn,
  InterestOptions,
  InterestResult,
  ObjectFilter,
  ObjectInterestConfig,
  QueryFn,
} from './interests.js';
export { mergeFilters, normalizeSort } from './interests.js';
// Agent orchestration (#1892): the standard invoke-agent tool + completion
// dispatch convention, built on executeAsPrincipal + the DispatchBus.
export {
  AGENT_COMPLETED_SIGNAL,
  AGENT_INVOKE_SIGNAL,
  type AgentCompletion,
  agentInvokeSignalType,
  type CreateInvokeAgentToolOptions,
  createDispatchInvokeTransport,
  createInvokeAgentTool,
  emitAgentCompletion,
  executeDelegatedInvocation,
  INVOKE_AGENT_FUNCTION_NAME,
  INVOKE_AGENT_TOOL_SLUG,
  type InvokeAgentDelivery,
  type InvokeAgentResult,
  type InvokeAgentTransport,
  inlineInvokeAgentTransport,
  type PrincipalTool,
  type PrincipalToolContext,
  processAgentInvocations,
  surfaceAgentCompletions,
  type WorkerInvocation,
  type WorkerRunner,
} from './invoke-agent.js';
// Opt-in Learning trait config (#1886). The underlying LearningMemory + its
// records/outcomes live in @happyvertical/smrt-core.
export {
  type AgentLearningConfig,
  type AgentLearningDeclaration,
  type ResolvedAgentLearning,
  resolveAgentLearning,
} from './learning.js';
export {
  AGENT_SCHEDULE_SLUG_BACKFILL,
  AGENT_SCHEDULE_TABLE,
  AgentScheduleSlugBackfillError,
  type AgentScheduleSlugBackfillOptions,
  type AgentScheduleSlugBackfillPlan,
  type AgentScheduleSlugBackfillResult,
  canonicalScheduleSlug,
  migrateAgentScheduleSlugs,
  planAgentScheduleSlugMigration,
} from './migrations/agent-schedule-slugs.js';
// Server-plane playbook preflight (#2590) — advisory prediction, never a grant.
export {
  type CreatePlaybookPreflightToolOptions,
  createPlaybookPreflightTool,
  filterPlaybooksByPreflight,
  PLAYBOOK_PREFLIGHT_FUNCTION_NAME,
  PLAYBOOK_PREFLIGHT_TOOL_SLUG,
  playbookStepCollection,
  playbookStepToolSlug,
} from './playbook-preflight.js';
export {
  createReportDataSurfaceDefinition,
  createReportDataSurfaceTools,
  REPORT_DRILLDOWN_FUNCTION_NAME,
  REPORT_DRILLDOWN_TOOL_SLUG,
  REPORT_EXPORT_FUNCTION_NAME,
  REPORT_EXPORT_TOOL_SLUG,
  REPORT_QUERY_FUNCTION_NAME,
  REPORT_QUERY_TOOL_SLUG,
  REPORT_REFRESH_FUNCTION_NAME,
  REPORT_REFRESH_TOOL_SLUG,
  type ReportDataSurfaceAuditEntry,
  ReportDataSurfaceConfigurationError,
  type ReportDataSurfaceDefinition,
  type ReportDataSurfaceExportHost,
  type ReportDataSurfaceRefreshHost,
  type ReportDataSurfaceToolsOptions,
  type ReportDataSurfaceVisibleAck,
  type ReportDataSurfaceVisibleCommand,
  ReportDataSurfaceVisibleError,
  type ReportDataSurfaceVisibleHost,
} from './report-data-surface.js';
export {
  AgentSchedule,
  AgentScheduleCollection,
  type ScheduleStatus,
} from './schedule.js';
export type {
  SummaryArticleImage,
  SummaryArticleOptions,
  SummaryArticleResult,
} from './summary-article.js';
export {
  type ResolvedAgentAvailability,
  TenantAgent,
  TenantAgentCollection,
  type TenantAgentStatus,
} from './tenant-agent.js';
export type { AgentStatusType } from './types.js';
// UI types and registry for admin panels
export {
  type AdminPanelBaseProps,
  type AgentAdminExport,
  type AgentAdminNavItem,
  type AgentAdminRootProps,
  type AgentAdminRoute,
  type AgentManifestInfo,
  type AgentRouteLoadContext,
  type AgentRouteLoadFn,
  type AgentUIComponentRegistry,
  AgentUIRegistry,
  type AgentUISlot,
  type AgentUISlots,
  type ComponentType,
  createUIRegistry,
} from './ui.js';
