/**
 * @happyvertical/smrt-svelte/workspace
 *
 * Workspace shell primitives for admin UIs. See packages/smrt-svelte/CLAUDE.md
 * for layering principles. Implementations land via #1227, #1228, #1229.
 */

export { default as Breadcrumbs } from './Breadcrumbs.svelte';
export { default as NavTree } from './NavTree.svelte';
export type {
  AvailableTool,
  BreadcrumbItem,
  NavItem,
  ToolDef,
  ToolsDockApi,
  ToolsDockContext,
} from './types.js';
export { default as WorkspaceShell } from './WorkspaceShell.svelte';

// Component exports land via implementer PRs:
//   #1227: WorkspaceShell (landed)
//   #1228: NavTree, Breadcrumbs (landed)
//   #1229: ToolsDock, defineToolsDock, useToolsDock
