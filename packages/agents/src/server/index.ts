/**
 * Server-side utilities for SMRT agents
 *
 * This module provides functions for server-side agent operations:
 * - Manifest loading and registration (replacing manual per-package imports)
 * - Agent serialization for client transport
 * - Config loading from the database
 *
 * @example
 * ```typescript
 * import {
 *   loadManifestsFromConfig,
 *   serializeResolvedAgent,
 *   loadSlotConfigs,
 * } from '@happyvertical/smrt-agents/server';
 *
 * // One-call manifest setup (replaces manual per-package registration)
 * loadManifestsFromConfig();
 *
 * // Serialize resolved agents for the UI
 * const serialized = resolved.map(serializeResolvedAgent);
 *
 * // Load slot configs from database
 * const configs = await loadSlotConfigs(agents, { db: dbConfig });
 * ```
 *
 * @module @happyvertical/smrt-agents/server
 */

export type {
  AgentActionContext,
  AgentActionHandler,
  AgentActionMap,
} from './action-types.js';
export {
  type AgentAPIRouteInfo,
  buildRouteMap,
  type ResolvedAPIRoute,
  resolveAPIRoute,
} from './api-routes.js';
export { loadSlotConfigs } from './config-loader.js';
export {
  createDataSurfaceActionAdapter,
  type DataSurfaceActionAdapter,
  type DataSurfaceActionAdapterOptions,
  type DataSurfaceActionContext as DataSurfaceServerActionContext,
  type DataSurfaceActionEligibility,
  type DataSurfaceActionExecution,
  type DataSurfaceActionPayloadValidation,
  type DataSurfaceActionRowOutcome,
  type DataSurfaceActionStateStore,
  type DataSurfaceBackgroundActionJob,
  type DataSurfaceBackgroundQueue,
  type DataSurfaceConfirmationPolicy,
  type DataSurfaceIdempotencyRecord,
  type DataSurfaceIdempotencyReservation,
  type DataSurfacePreviewTokenRecord,
  type DataSurfaceServerActionDefinition,
  type DataSurfaceServerActionRequest,
  InMemoryDataSurfaceActionStateStore,
  isBoundedDataSurfaceJsonValue,
  type ResolvedDataSurfaceActions,
  type ResolvedDataSurfaceSelection,
} from './data-surface-actions.js';
export {
  extractAgentManifest,
  extractAgentPackagesFromConfig,
  loadManifestsFromConfig,
  loadManifestsFromPackages,
  type PackageManifest,
} from './manifest-utils.js';
export {
  type SerializedAgent,
  serializeResolvedAgent,
} from './serialization.js';
