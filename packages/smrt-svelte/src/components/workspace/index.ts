/**
 * @happyvertical/smrt-svelte/workspace
 *
 * Workspace shell primitives for admin UIs. See packages/smrt-svelte/CLAUDE.md
 * for layering principles. Implementations land via #1227, #1228, #1229.
 */

export { default as Breadcrumbs } from './Breadcrumbs.svelte';
export { default as NavTree } from './NavTree.svelte';
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
  BreadcrumbItem,
  NavItem,
  ToolDef,
  ToolsDockApi,
  ToolsDockContext,
} from './types.js';
export { default as WorkspaceShell } from './WorkspaceShell.svelte';
