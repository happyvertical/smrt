/**
 * Explicit compatibility entry for the first-generation ToolsDock family.
 *
 * The canonical `@happyvertical/smrt-svelte/workspace` surface is AdminShell.
 * Existing applications that still need ToolsDock while migrating can import
 * this opt-in subpath without adding legacy components back to that barrel.
 */

export {
  type DefineToolsDockOptions,
  defineToolsDock,
  TOOLS_DOCK_KEY,
  type ToolsDockInstance,
} from './tools-dock/define-tools-dock.svelte.js';
export { default as ToolsDock } from './tools-dock/ToolsDock.svelte';
export { tryUseToolsDock, useToolsDock } from './tools-dock/use-tools-dock.js';
export type {
  AvailableTool,
  ToolDef,
  ToolsDockApi,
  ToolsDockContext,
  ToolsDockEvents,
} from './types.js';
