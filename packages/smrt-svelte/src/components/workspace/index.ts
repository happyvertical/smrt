/**
 * @happyvertical/smrt-svelte/workspace
 *
 * Canonical AdminShell family for SMRT admin UIs. The first-generation
 * WorkspaceShell / RoleShell / NavTree / ToolsDock source files remain in this
 * package as migration references, but the public workspace surface now points
 * at the four-edge AdminShell contract.
 */

// Phone surfaces and swipe-to-dismiss live in the smrt-ui leaf; re-exported
// here so a shell host has one import for its chrome.
export {
  type SwipeDirection,
  type SwipeDismissOptions,
  swipeDismiss,
  swipeDismisses,
} from '@happyvertical/smrt-ui/feedback';
export { default as ActivityBadge } from './admin-shell/ActivityBadge.svelte';
export { default as ActivityItem } from './admin-shell/ActivityItem.svelte';
export { default as ActivityList } from './admin-shell/ActivityList.svelte';
export { default as ActivityTicker } from './admin-shell/ActivityTicker.svelte';
export { default as ActivityToasts } from './admin-shell/ActivityToasts.svelte';
export { default as AdminShell } from './admin-shell/AdminShell.svelte';
export { default as AppScopePanel } from './admin-shell/AppScopePanel.svelte';
export {
  ADMIN_SHELL_CONTEXT,
  setAdminShell,
  tryUseAdminShell,
  useAdminShell,
} from './admin-shell/context.js';
export { type ShellDock, useShellDock } from './admin-shell/dock.js';
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
export * from './admin-shell/layout.js';
export {
  SHELL_LAYOUT_CONTEXT,
  setShellLayout,
  tryUseShellLayout,
  useShellLayout,
} from './admin-shell/layout-context.js';
export {
  ShellLayoutController,
  type ShellLayoutControllerOptions,
  type ShellLayoutPanelView,
  type ShellPlacementView,
} from './admin-shell/layout-controller.svelte.js';
export {
  type BottomBarMode,
  bottomBarMode,
  FORM_ACTION_BAR_SELECTOR,
  findShellNavTrail,
  keyboardLikelyOpen,
  normalizeShellPath,
  type PhoneBottomBarItem,
  type PhoneTopBarInput,
  type PhoneTopBarModel,
  phoneTopBarFor,
  ScrollChrome,
  type ScrollChromeOptions,
  type ScrollSample,
  type ShellCrumb,
  type ShellIcon,
  type ShellNavPathItem,
  type ShellPageTrail,
  type ShellPageTrailInput,
  shellNavItemMatches,
  shellPageTrailFor,
  viewportFor,
} from './admin-shell/mobile-shell.js';
export {
  installKeyboardWatcher,
  installScrollChrome,
  installShellViewport,
  watchFormActionBar,
} from './admin-shell/mobile-shell-dom.js';
export { default as PhoneBottomBar } from './admin-shell/PhoneBottomBar.svelte';
export { default as PhoneTopBar } from './admin-shell/PhoneTopBar.svelte';
export { default as ShellCorner } from './admin-shell/ShellCorner.svelte';
export { default as ShellDockTool } from './admin-shell/ShellDockTool.svelte';
export { default as ShellIconButton } from './admin-shell/ShellIconButton.svelte';
export { default as ShellLayoutEditor } from './admin-shell/ShellLayoutEditor.svelte';
export { default as ShellNavEditor } from './admin-shell/ShellNavEditor.svelte';
export { default as ShellNavToggle } from './admin-shell/ShellNavToggle.svelte';
export { default as ShellSectionIcon } from './admin-shell/ShellSectionIcon.svelte';
export { default as ShellSectionMenu } from './admin-shell/ShellSectionMenu.svelte';
export { default as ShellSettingsPanel } from './admin-shell/ShellSettingsPanel.svelte';
export { default as ShellTitle } from './admin-shell/ShellTitle.svelte';
export { default as ShortcutsOverlay } from './admin-shell/ShortcutsOverlay.svelte';
export { default as SystemScopePanel } from './admin-shell/SystemScopePanel.svelte';
export { default as SystemStatusChips } from './admin-shell/SystemStatusChips.svelte';
export {
  clampPanelSize,
  DEFAULT_SHELL_KEYMAP,
  DEFAULT_SHELL_PANEL_RESIZE,
  LocalStorageShellSettingsAdapter,
  mergeShellSettingsDelta,
  panelPersists,
  pruneShellSettingsDelta,
  resolveHotkey,
  resolveInitialPanelState,
  resolvePanelResize,
  resolveShellConfig,
  stripUnpersistedSettings,
} from './admin-shell/settings.js';
export {
  isShellIconName,
  SHELL_DEFAULT_SECTION_ICON,
  SHELL_ICON_PATHS,
  SHELL_SECTION_ICONS,
  type ShellIconName,
} from './admin-shell/shell-icons.js';
export type {
  ShellPlacementItem,
  ShellRegion,
  ShellSlot,
} from './admin-shell/slots.js';
export {
  isShellSlot,
  resolveSlot,
  SHELL_DOCK_ITEM_PREFIX,
  SHELL_HOST_SLOT_ITEM_PREFIX,
  SHELL_SLOTS,
  shellDockItemId,
  shellHostSlotItemId,
  slotFallbackChain,
  slotRegion,
} from './admin-shell/slots.js';
export {
  ADMIN_SHELL_DESKTOP_QUERY,
  ADMIN_SHELL_PHONE_QUERY,
  createShellState,
  detectShellViewport,
  ShellState,
  type ShellStateOptions,
} from './admin-shell/state.svelte.js';
export { default as TenantNav } from './admin-shell/TenantNav.svelte';
export type {
  ActivityStatus,
  AdminShellPhoneOptions,
  AdminShellProps,
  PanelEdge,
  PanelPresentation,
  PanelState,
  PhonePanelPresentation,
  ResolvedShellConfig,
  ShellActivity,
  ShellActivityBadge,
  ShellActivityEvent,
  ShellActivityFilter,
  ShellDockOpenOptions,
  ShellFocusTool,
  ShellFocusToolSubject,
  ShellHotkeyBinding,
  ShellLayoutEditSurface,
  ShellNavGroup,
  ShellNavItem,
  ShellNavItemAction,
  ShellPanelConfig,
  ShellPanelDefaults,
  ShellPanelPersist,
  ShellPanelResize,
  ShellScope,
  ShellSectionActionsContext,
  ShellSectionMenuEntry,
  ShellSettingsAdapter,
  ShellSettingsDelta,
  ShellStateSnapshot,
  ShellStatusChip,
  ShellStatusTone,
  ShellSystemItem,
  ShellSystemPanel,
  ShellViewport,
  VisiblePanelState,
  WorkspaceAccountTenant,
} from './admin-shell/types.js';
export {
  ADMIN_SHELL_REGION_IDS,
  EDGE_SCOPES,
  PANEL_EDGES,
  SCOPE_EDGES,
} from './admin-shell/types.js';
export { default as WorkspaceAccountMenu } from './admin-shell/WorkspaceAccountMenu.svelte';

export {
  type NavSection,
  type NavTreeFromManifestOptions,
  navTreeFromManifest as tenantNavFromManifest,
  pluralizeClassName,
  type SmrtManifestEntryLike,
  type SmrtManifestLike,
} from './manifest-nav.js';
