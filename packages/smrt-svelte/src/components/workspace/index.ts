/**
 * @happyvertical/smrt-svelte/workspace
 *
 * Canonical AdminShell family for SMRT admin UIs. The first-generation
 * WorkspaceShell / RoleShell / NavTree / ToolsDock source files remain in this
 * package as migration references, but the public workspace surface now points
 * at the four-edge AdminShell contract.
 */

export { default as ActivityBadge } from './admin-shell/ActivityBadge.svelte';
export { default as ActivityItem } from './admin-shell/ActivityItem.svelte';
export { default as ActivityList } from './admin-shell/ActivityList.svelte';
export { default as ActivityToasts } from './admin-shell/ActivityToasts.svelte';
export { default as AdminShell } from './admin-shell/AdminShell.svelte';
export { default as AppScopePanel } from './admin-shell/AppScopePanel.svelte';
export {
  ADMIN_SHELL_CONTEXT,
  setAdminShell,
  tryUseAdminShell,
  useAdminShell,
} from './admin-shell/context.js';
export { default as HotkeyInput } from './admin-shell/HotkeyInput.svelte';
export {
  formatHotkeyBinding,
  hotkeyMatchesEvent,
  isEditableTarget,
  isShortcutsEvent,
  type ShellHotkeyAction,
  shellActionFromKeyboardEvent,
  shouldIgnoreShellHotkey,
} from './admin-shell/hotkeys.js';
export { default as ShellCorner } from './admin-shell/ShellCorner.svelte';
export { default as ShellDockTool } from './admin-shell/ShellDockTool.svelte';
export { default as ShellSettingsPanel } from './admin-shell/ShellSettingsPanel.svelte';
export { default as ShortcutsOverlay } from './admin-shell/ShortcutsOverlay.svelte';
export { default as SystemScopePanel } from './admin-shell/SystemScopePanel.svelte';
export { default as SystemStatusChips } from './admin-shell/SystemStatusChips.svelte';
export {
  DEFAULT_SHELL_KEYMAP,
  LocalStorageShellSettingsAdapter,
  mergeShellSettingsDelta,
  pruneShellSettingsDelta,
  resolveHotkey,
  resolveInitialPanelState,
  resolveShellConfig,
} from './admin-shell/settings.js';
export { createShellState, ShellState } from './admin-shell/state.svelte.js';
export { default as TenantNav } from './admin-shell/TenantNav.svelte';
export type {
  ActivityStatus,
  AdminShellProps,
  PanelEdge,
  PanelPresentation,
  PanelState,
  ResolvedShellConfig,
  ShellActivity,
  ShellActivityBadge,
  ShellActivityEvent,
  ShellActivityFilter,
  ShellFocusTool,
  ShellFocusToolSubject,
  ShellHotkeyBinding,
  ShellNavItem,
  ShellPanelConfig,
  ShellPanelDefaults,
  ShellScope,
  ShellSettingsAdapter,
  ShellSettingsDelta,
  ShellStateSnapshot,
  ShellStatusChip,
  ShellStatusTone,
  ShellSystemItem,
  ShellSystemPanel,
  VisiblePanelState,
} from './admin-shell/types.js';
export { EDGE_SCOPES, PANEL_EDGES, SCOPE_EDGES } from './admin-shell/types.js';

export {
  type NavSection,
  type NavTreeFromManifestOptions,
  navTreeFromManifest as tenantNavFromManifest,
  pluralizeClassName,
  type SmrtManifestEntryLike,
  type SmrtManifestLike,
} from './manifest-nav.js';
