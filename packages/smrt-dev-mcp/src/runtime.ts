/**
 * `@happyvertical/smrt-dev-mcp/runtime`: the runtime tool functions as a
 * plain map, for in-process callers (the `smrt dev:runtime` CLI fallback,
 * tests) that want the envelopes without an MCP transport.
 */
export {
  runtimeObject,
  runtimeRegistry,
  runtimeSchemaDiff,
} from './tools/runtime/observation.js';
export {
  RUNTIME_PROVENANCE,
  type RuntimeDiagnostic,
  type RuntimeToolEnvelope,
  runtimeDispatchHealth,
  runtimeJobHealth,
  runtimeMigrationStatus,
  runtimeRecentChanges,
  runtimeRegistryDrift,
  runtimeScheduleHealth,
  STATIC_PROVENANCE,
} from './tools/runtime/tools.js';

import {
  runtimeObject,
  runtimeRegistry,
  runtimeSchemaDiff,
} from './tools/runtime/observation.js';
import {
  type RuntimeToolEnvelope,
  runtimeDispatchHealth,
  runtimeJobHealth,
  runtimeMigrationStatus,
  runtimeRecentChanges,
  runtimeRegistryDrift,
  runtimeScheduleHealth,
} from './tools/runtime/tools.js';

/** Name → handler for every Level 2 runtime tool. */
export const RUNTIME_TOOLS = {
  'runtime-registry': (args: Record<string, unknown>) =>
    runtimeRegistry(args as never),
  'runtime-object': (args: Record<string, unknown>) =>
    runtimeObject(args as never),
  'runtime-schema-diff': (args: Record<string, unknown>) =>
    runtimeSchemaDiff(args as never),
  'migration-status': (args: Record<string, unknown>) =>
    runtimeMigrationStatus(args as never),
  'job-health': (args: Record<string, unknown>) =>
    runtimeJobHealth(args as never),
  'schedule-health': (args: Record<string, unknown>) =>
    runtimeScheduleHealth(args as never),
  'dispatch-health': (args: Record<string, unknown>) =>
    runtimeDispatchHealth(args as never),
  'recent-changes': (args: Record<string, unknown>) =>
    runtimeRecentChanges(args as never),
  'registry-drift': (args: Record<string, unknown>) =>
    runtimeRegistryDrift(args as never),
} satisfies Record<
  string,
  (args: Record<string, unknown>) => Promise<RuntimeToolEnvelope>
>;
