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

export { loadSlotConfigs } from './config-loader.js';
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
