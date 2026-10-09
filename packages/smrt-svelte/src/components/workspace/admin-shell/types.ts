import type { Component, Snippet } from 'svelte';
import type { ShellLayout } from './layout.js';
import type { ShellRegion, ShellSlot } from './slots.js';

export type PanelEdge = 'top' | 'left' | 'right' | 'bottom';
export type ShellScope = 'app' | 'tenant' | 'focus' | 'system';
export type PanelState = 'hidden' | 'collapsed' | 'expanded';
export type VisiblePanelState = Exclude<PanelState, 'hidden'>;
export type PanelPresentation = 'push' | 'overlay';
/**
 * Width class the shell is laid out for: `phone` up to 48rem (edges become
 * drawers), `tablet` up to 64rem, `desktop` from 64rem. See
 * `ADMIN_SHELL_PHONE_QUERY` / `ADMIN_SHELL_DESKTOP_QUERY`.
 */
export type ShellViewport = 'phone' | 'tablet' | 'desktop';
/**
 * How a side edge is presented on phones: `drawer` (the default, slides in
 * from its side), `sheet` (right edge only: rises from the bottom), or
 * `hidden` (not rendered on phones; the host shows its content elsewhere).
 */
export type PhonePanelPresentation = 'drawer' | 'sheet' | 'hidden';
export type ActivityStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface ShellHotkeyBinding {
  code: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface ShellPanelConfig {
  edge: PanelEdge;
  scope: ShellScope;
  label: string;
  initial: PanelState;
  presentation: PanelPresentation;
  hotkey: ShellHotkeyBinding | null;
  collapsedSize: string;
  expandedSize: string;
  exclusiveGroup?: string;
  /**
   * Open/closed state per viewport class, applied on first render and again
   * whenever the viewport class changes (e.g. `{ phone: 'collapsed', tablet:
   * 'collapsed', desktop: 'expanded' }`). The user's toggle sticks until the
   * class changes. An edge with viewport defaults never persists its state.
   */
  viewportDefaults?: Partial<Record<ShellViewport, VisiblePanelState>>;
  /** Phone presentation of a side edge (default `drawer`). */
  phone?: PhonePanelPresentation;
  /**
   * Media query under which an expanded `push` side edge is laid over the
   * page (sliding in above a scrim) instead of pushing it aside, on tablet
   * and desktop. Above it the edge docks as usual. Phones keep their
   * `phone` presentation. E.g. `'(max-width: 99.9375rem)'` overlays up to
   * the Material 3 "Large" window class (under 1600px).
   */
  overlayMedia?: string;
  /**
   * Drag-to-resize for a `push` side edge on tablet/desktop: a separator on
   * the edge's inner border (pointer drag, arrow keys, Home/End, double-click
   * or Enter to reset). `true` uses the default limits.
   */
  resizable?: boolean | ShellPanelResize;
  /**
   * What the settings adapter stores for this edge (default: everything).
   * `false` stores nothing; `{ state: false }` keeps only the size.
   */
  persist?: boolean | ShellPanelPersist;
  /**
   * Keep the edge's panel content mounted (and hidden) while the edge is
   * collapsed, instead of unmounting it. Use it when the panel holds state
   * that must survive closing, such as an assistant chat's draft on the
   * phone sheet. Applies to the expanded content (`appPanel`,
   * `tenantPanel`, the focus panel, `systemPanel`); the rail still renders
   * as usual. A hidden edge unmounts everything.
   */
  keepMounted?: boolean;
  /**
   * `false`: a side edge has no rail: no focus-tool buttons or edge toggle,
   * open or closed, and no space while closed (nothing to tab to). A host
   * opens and closes it from elsewhere, e.g. a dock toggle in the header.
   * Edit mode still shows its region controls. Default `true`.
   */
  rail?: boolean;
}

/** Limits for a resizable side edge, in CSS pixels. */
export interface ShellPanelResize {
  /** Smallest expanded width (default 240). */
  min?: number;
  /** Largest expanded width (default 720). */
  max?: number;
  /** Arrow-key step (default 16; Shift multiplies by 4). */
  step?: number;
}

/** Which of an edge's user settings the settings adapter stores. */
export interface ShellPanelPersist {
  /** Open/closed state (default true). */
  state?: boolean;
  /** Resized width (default true). */
  size?: boolean;
}

export type ShellPanelDefaults = Partial<
  Record<PanelEdge, Partial<ShellPanelConfig> | false>
>;

export interface ShellSettingsDelta {
  hotkeysEnabled?: boolean;
  keymap?: Partial<Record<PanelEdge, ShellHotkeyBinding | null>>;
  panels?: Partial<Record<PanelEdge, PanelState>>;
  /** Resized expanded widths in px; `null` resets to the configured size. */
  sizes?: Partial<Record<PanelEdge, number | null>>;
  activeFocusToolId?: string | null;
  /**
   * The user's shell layout customization (panel visibility, navigation
   * order and visibility). Stored here only when the host passes neither
   * `layout` nor `onlayoutchange` to `AppShell`.
   */
  layout?: ShellLayout;
}

export interface ShellSettingsAdapter {
  read(): ShellSettingsDelta | null | Promise<ShellSettingsDelta | null>;
  write(delta: ShellSettingsDelta): void | Promise<void>;
}

export interface ResolvedShellConfig {
  panels: Record<PanelEdge, ShellPanelConfig>;
}

export interface ShellFocusToolSubject {
  type: string;
  id: string;
  label?: string;
}

/** Labelled, collapsible group of tenant navigation links. */
export interface ShellNavGroup {
  /**
   * Stable identity for layout customization ({@link ShellLayout}). Defaults
   * to `heading`; set it when the heading is translated or may be renamed.
   */
  id?: string;
  heading: string;
  /**
   * `false` renders the items flat, without a visible heading; the group keeps
   * an accessible name. Hosts suggest it; a user's layout can override it.
   */
  showTitle?: boolean;
  /**
   * The section's icon: a shell icon name (`SHELL_SECTION_ICONS`) or a name
   * the host's `iconComponent` renders. Shown by `navMode: 'sections'`; the
   * user can override it in the layout (`sections[id].icon`).
   */
  icon?: string;
  /**
   * Where the section's own page (overview) lives. `navMode: 'sections'`
   * links the section here and treats it as current on this page; without it
   * the first visible item's href is used.
   */
  href?: string;
  items: ShellNavItem[];
}

/**
 * Optional trailing icon-only link on a {@link ShellNavItem}, for example a
 * settings gear that opens the item's section settings. Not rendered when the
 * nav is collapsed; the target page stays reachable through its own route.
 */
export interface ShellNavItemAction {
  href: string;
  /** Accessible name and tooltip, e.g. "Sales options". Required: icon-only. */
  label: string;
  /** Icon name from the set `ShellNavItem.icon` uses. Defaults to a settings gear. */
  icon?: string;
  /**
   * `'always'` renders the link whenever the nav is expanded; `'active'`
   * renders it only while the item's section is current (the link is absent
   * otherwise, not merely hidden). Default `'always'`.
   */
  visibility?: 'always' | 'active';
}

export interface ShellNavItem {
  /**
   * Stable identity for layout customization ({@link ShellLayout}). Defaults
   * to `href`; set it when the href may change or two items share one.
   */
  id?: string;
  href: string;
  label: string;
  /**
   * Set by `applyShellLayout` on an item the user renamed: the host's original
   * label (`label` then holds the user's). Hosts do not set it.
   */
  defaultLabel?: string;
  icon?: string;
  description?: string;
  badge?: number | string | null;
  /**
   * Show a "needs attention" dot on the item (also over its icon when the
   * nav is collapsed). `true` announces the default label ("Needs
   * attention"); a string is the accessible label to announce instead
   * (e.g. "A background job failed recently").
   */
  attention?: boolean | string | null;
  children?: ShellNavItem[];
  /**
   * Trailing action link. "Section current" means: for an item in a
   * {@link ShellNavGroup}, any item of the group, their children, or any
   * action href is the current page; for a top-level item, the item, its
   * children, or its action href is current.
   */
  action?: ShellNavItemAction;
}

/** Tenant option rendered by {@link WorkspaceAccountMenu}. */
export interface WorkspaceAccountTenant {
  id: string;
  label: string;
  roleLabel?: string;
  disabled?: boolean;
}

export interface ShellFocusTool {
  id: string;
  label: string;
  description?: string;
  order?: number;
  badge?: number | string | null;
  /** Optional icon component rendered by the default focus rail. */
  icon?: Component | null;
  component?: Component | null;
  render?: Snippet<[{ tool: ShellFocusTool }]>;
  scopeId?: string;
  subject?: ShellFocusToolSubject;
  activityKinds?: string[];
}

/** Options for opening a dock tool from code (see `useShellDock`). */
export interface ShellDockOpenOptions {
  /** Move focus into the dock once it is open. Default true. */
  focus?: boolean;
  /**
   * Where focus goes back to when the dock closes. Default: the element
   * focused when the dock was opened.
   */
  returnFocus?: HTMLElement | null;
}

export interface ShellActivity {
  id: string;
  label: string;
  kind: string;
  scope: ShellScope;
  status: ActivityStatus;
  subject?: ShellFocusToolSubject;
  edge?: PanelEdge;
  progress?: number | null;
  detailHref?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  cancel?: () => void | Promise<void>;
}

export interface ShellActivityFilter {
  edge?: PanelEdge;
  scope?: ShellScope;
  kind?: string | string[];
  status?: ActivityStatus | ActivityStatus[];
  subject?: ShellFocusToolSubject;
}

export interface ShellActivityBadge {
  count: number;
  running: number;
  hasFailed: boolean;
  progress: number | null;
}

export interface ShellActivityEvent {
  type: 'upsert' | 'transition' | 'remove';
  activity: ShellActivity;
  previous?: ShellActivity;
}

export type ShellStatusTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

export interface ShellStatusChip {
  id: string;
  label: string;
  value?: string | number;
  tone?: ShellStatusTone;
  href?: string;
}

export interface ShellSystemItem {
  id: string;
  label: string;
  status: string;
  detail?: string;
  href?: string;
  updatedAt?: string;
}

export interface ShellSystemPanel {
  id: string;
  label: string;
  items: ShellSystemItem[];
}

export interface ShellStateSnapshot {
  panels: Record<PanelEdge, PanelState>;
  viewport: ShellViewport;
  activeFocusToolId: string | null;
  settings: ShellSettingsDelta;
}

/** Phone behavior switches for `AdminShell` (all off by default). */
export interface AdminShellPhoneOptions {
  /** Dim the page behind an open side drawer or sheet; a tap closes it. */
  scrim?: boolean;
  /** Close drawers by swiping them away (left drawer left, right drawer right, sheet down). */
  swipeToClose?: boolean;
  /** Hide the `phoneTopBar` while scrolling down (default true). */
  hideOnScroll?: boolean;
}

/**
 * The in-place layout editing surface `AppShell` hands to `AdminShell`. While
 * `active`, every slot of a visible region renders as a labelled drop zone
 * (`zone` draws its content) and each region in `hiddenRegions` renders as a
 * thin strip (`strip`).
 */
export interface ShellLayoutEditSurface {
  active: boolean;
  /** The slot highlighted as the current drop target, if any. */
  highlight?: ShellSlot | null;
  /** Content of one slot's drop zone. */
  zone: Snippet<[ShellSlot]>;
  /** Regions the user hid, drawn as strips so they can be shown again. */
  hiddenRegions?: readonly ShellRegion[];
  /** Content of one hidden region's strip. */
  strip?: Snippet<[ShellRegion]>;
  /** Edit controls on a visible region (e.g. a hide button). */
  regionControl?: Snippet<[ShellRegion]>;
}

/**
 * What a host's `sectionActions` snippet receives for each navigation section
 * while the layout is being edited: render icon buttons (e.g. an Options gear
 * or Help) and they join the section's overlay icons and floating toolbar.
 */
export interface ShellSectionActionsContext {
  /** The section id (`ShellNavGroup.id ?? heading`, or `custom:...`). */
  sectionId: string;
  /** The section's current (possibly renamed) label. */
  label: string;
  /** A user-created section. */
  custom: boolean;
  /** Always `true` today; actions render only while the layout is edited. */
  editing: boolean;
}

export interface AdminShellProps {
  title?: string;
  /** Optional destination for the default brand and compact rail mark. */
  homeHref?: string;
  /**
   * Show the edge toggle buttons (and their hotkey hints) that open and close
   * the drop-down edge panels: `true` for all four edges, or a per-edge map.
   * Default `false`: no toggles, no hotkeys, and each region is laid out
   * inline (its slots and content visible) instead of a collapsed bar that
   * expands as a drop-down. Visibility then comes from the layout
   * (`ShellLayout.panels`). Existing apps keep the old behaviour with `true`.
   * A phone still gets the Menu opener and drawer for the left sidebar.
   */
  edgeToggles?: boolean | Partial<Record<PanelEdge, boolean>>;
  /**
   * Keyboard shortcuts (WASD, `?`). Default: active only for edges that have
   * toggles. `true` enables them for every edge (the panels then behave as
   * drop-downs without a button); `false` disables them.
   */
  hotkeys?: boolean;
  /**
   * The brand is rendered by the host as a slot item (`AppShell` supplies
   * `item:brand` in `header.start`), so the top band does not draw its own.
   */
  brandInSlot?: boolean;
  /**
   * @deprecated Alias for `edgeToggles.left`: `true` shows the left edge's
   * toggle, `false` hides it even when `edgeToggles` is on.
   */
  showTenantToggle?: boolean;
  /** Optional brand logo URL. */
  logoSrc?: string;
  /** Alternative text for the logo (decorative by default). */
  logoAlt?: string;
  /** Custom brand content, receiving whether it is in the compact rail. */
  brand?: Snippet<[{ compact: boolean }]>;
  subtitle?: string;
  config?: ShellPanelDefaults;
  settings?: ShellSettingsDelta;
  settingsAdapter?: ShellSettingsAdapter;
  storageKey?: string;
}

export const PANEL_EDGES: PanelEdge[] = ['top', 'left', 'right', 'bottom'];

export const EDGE_SCOPES: Record<PanelEdge, ShellScope> = {
  top: 'app',
  left: 'tenant',
  right: 'focus',
  bottom: 'system',
};

export const SCOPE_EDGES: Record<ShellScope, PanelEdge> = {
  app: 'top',
  tenant: 'left',
  focus: 'right',
  system: 'bottom',
};

/**
 * Public element ids of AdminShell's regions, stable for `aria-controls`,
 * skip links, and host styling. `main` is the page scroller: the shell is
 * pinned to the viewport and page content scrolls inside it.
 */
export const ADMIN_SHELL_REGION_IDS = {
  header: 'smrt-admin-shell-header',
  top: 'smrt-admin-shell-top-panel',
  left: 'smrt-admin-shell-left-panel',
  right: 'smrt-admin-shell-right-panel',
  bottom: 'smrt-admin-shell-bottom-panel',
  main: 'smrt-admin-shell-main',
} as const;

/** One row of the menu, as passed to the `meta` and `actions` snippets. */
export interface ShellSectionMenuEntry {
  id: string;
  href: string;
  /** The displayed label (the user's rename, else the host's). */
  label: string;
  /** The host's label. */
  defaultLabel: string;
  icon?: string;
  hidden: boolean;
  item: ShellNavItem;
}
