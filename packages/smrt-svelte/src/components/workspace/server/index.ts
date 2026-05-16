/**
 * @happyvertical/smrt-svelte/workspace/server
 *
 * Server-only utilities for the workspace shell — currently the dock
 * availability gate composer (Phase 4c per happyvertical/smrt#1226).
 *
 * Node-safe: no Svelte component imports, no browser-only APIs. Import
 * this subpath from `+server.ts` endpoints, REST handlers, or anywhere
 * else outside the client bundle.
 */

export { composeDockAvailability } from './compose-availability.js';
export type {
  AvailableTool,
  ComposeDockAvailabilityOptions,
  GatedToolSummary,
  GateEvaluationContext,
  GateEvaluator,
} from './types.js';
