/**
 * @happyvertical/smrt-svelte/workspace/server
 *
 * Server-only utilities for the workspace shell: the dock availability gate
 * composer (Phase 4c per happyvertical/smrt#1226) and the shell settings
 * delta sanitizer and merge a server-side preference store uses (#3727).
 *
 * Node-safe: no Svelte component imports, no browser-only APIs. Import
 * this subpath from `+server.ts` endpoints, REST handlers, or anywhere
 * else outside the client bundle.
 */

export { mergeShellSettingsDelta } from '../admin-shell/settings.js';
export {
  type ShellSettingsDeltaCheck,
  type ShellSettingsIssue,
  sanitizeShellSettingsDelta,
} from '../admin-shell/settings-delta.js';
export type {
  ShellHotkeyBinding,
  ShellSettingsDelta,
} from '../admin-shell/types.js';
export { composeDockAvailability } from './compose-availability.js';
export type {
  AvailableTool,
  ComposeDockAvailabilityOptions,
  GatedToolSummary,
  GateEvaluationContext,
  GateEvaluator,
} from './types.js';
