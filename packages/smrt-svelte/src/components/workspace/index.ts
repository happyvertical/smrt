/**
 * @happyvertical/smrt-svelte/workspace
 *
 * Workspace shell primitives for admin UIs. See packages/smrt-svelte/CLAUDE.md
 * for layering principles. Implementations land via #1227, #1228, #1229.
 */

export { default as Breadcrumbs } from './Breadcrumbs.svelte';
export {
  type NavSection,
  type NavTreeFromManifestOptions,
  navTreeFromManifest,
  pluralizeClassName,
  type SmrtManifestEntryLike,
  type SmrtManifestLike,
} from './manifest-nav.js';
export { default as NavTree } from './NavTree.svelte';
export { default as RoleShell } from './RoleShell.svelte';
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
  RoleConfig,
  ToolDef,
  ToolsDockApi,
  ToolsDockContext,
  ToolsDockEvents,
} from './types.js';
export { default as WorkspaceShell } from './WorkspaceShell.svelte';
