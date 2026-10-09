import { untrack } from 'svelte';
import {
  isShellLayoutEmpty,
  type ShellLayout,
  type ShellLayoutPanel,
} from './layout.js';
import {
  clampPanelSize,
  LocalStorageShellSettingsAdapter,
  mergeShellSettingsDelta,
  resolveInitialPanelState,
  resolvePanelResize,
  resolveShellConfig,
  stripUnpersistedSettings,
} from './settings.js';
import type { ShellRegion } from './slots.js';
import type {
  ActivityStatus,
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
  ShellPanelDefaults,
  ShellPanelResize,
  ShellScope,
  ShellSettingsAdapter,
  ShellSettingsDelta,
  ShellStateSnapshot,
  ShellViewport,
  VisiblePanelState,
} from './types.js';
import { PANEL_EDGES, SCOPE_EDGES } from './types.js';

/**
 * Phones: up to 48rem (768px itself is a phone). The same boundary the
 * shell's CSS uses to turn side edges into drawers.
 */
export const ADMIN_SHELL_PHONE_QUERY = '(max-width: 48rem)';
/** Desktop starts at 64rem; between the two queries is a tablet. */
export const ADMIN_SHELL_DESKTOP_QUERY = '(min-width: 64rem)';

/** The viewport class for the current window (`desktop` without a DOM). */
export function detectShellViewport(): ShellViewport {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return 'desktop';
  }
  if (window.matchMedia(ADMIN_SHELL_PHONE_QUERY).matches) return 'phone';
  return window.matchMedia(ADMIN_SHELL_DESKTOP_QUERY).matches
    ? 'desktop'
    : 'tablet';
}

type ActivityListener = (event: ShellActivityEvent) => void;
type ShellActivityPatch = Partial<Omit<ShellActivity, 'id'>>;

export interface ShellStateOptions {
  config?: ShellPanelDefaults;
  settings?: ShellSettingsDelta;
  settingsAdapter?: ShellSettingsAdapter;
  storageKey?: string;
  /** Initial viewport class (default: detected from `window`, else desktop). */
  viewport?: ShellViewport;
  /** The user's per-edge layout overrides (see `ShellLayout.panels`). */
  layoutPanels?: ShellLayout['panels'];
}

export class ShellState {
  readonly config: ResolvedShellConfig;
  readonly adapter: ShellSettingsAdapter | null;

  settings = $state<ShellSettingsDelta>({});
  /** Edges opened for now only (never written to the settings). */
  private revealed = new Set<PanelEdge>();
  panels = $state<Record<PanelEdge, PanelState>>({
    top: 'collapsed',
    left: 'collapsed',
    right: 'collapsed',
    bottom: 'collapsed',
  });
  /** Width class the shell is laid out for; `AdminShell` keeps it current. */
  viewport = $state<ShellViewport>('desktop');
  focusTools = $state<ShellFocusTool[]>([]);
  activeFocusToolId = $state<string | null>(null);
  /**
   * Bumped by `openDockTool` / `toggleDockTool` when the dock should take
   * focus; `AdminShell` reacts to it once the panel is shown.
   */
  dockFocusRequest = $state(0);
  /** Element focus returns to when a dock opened from code closes. */
  dockReturnFocus: HTMLElement | null = null;
  activities = $state<ShellActivity[]>([]);
  /**
   * Side edges whose `overlayMedia` currently matches; `AdminShell` keeps
   * it current. Read it through `presentationFor`.
   */
  overlayMatches = $state<Partial<Record<PanelEdge, boolean>>>({});
  /**
   * The user's layout overrides per edge. `visible: false` keeps an edge
   * hidden (no toggle, hotkey, or restore control reopens it); `initial`
   * is the state it starts in. Set it through `setLayoutPanels`.
   */
  layoutPanels = $state<Partial<Record<PanelEdge, ShellLayoutPanel>>>({});
  /**
   * Edges laid out inline rather than as a toggled drop-down (`AdminShell`
   * `edgeToggles` off for the edge). An inline left edge is always docked
   * open off phones while visible (the right edge, the dock, never is); an inline top/bottom edge is its band
   * only. Everything is a drop-down (`false` here) unless set through
   * `setInlineEdges`, so a bare `ShellState` keeps its historic behaviour.
   */
  inlineEdges = $state<Partial<Record<PanelEdge, boolean>>>({});

  private activityListeners = new Set<ActivityListener>();

  constructor(options: ShellStateOptions = {}) {
    this.config = resolveShellConfig(options.config);
    this.adapter =
      options.settingsAdapter ??
      (options.storageKey
        ? new LocalStorageShellSettingsAdapter(options.storageKey)
        : null);
    this.viewport = options.viewport ?? detectShellViewport();
    this.layoutPanels = { ...(options.layoutPanels ?? {}) };
    this.applySettings(options.settings ?? {}, { persist: false });
  }

  async hydrate(): Promise<void> {
    if (!this.adapter) return;
    const delta = await this.adapter.read();
    if (delta) {
      this.applySettings(stripUnpersistedSettings(delta, this.config), {
        persist: false,
      });
    }
  }

  /**
   * Record the viewport class. When it changes, edges with
   * `viewportDefaults` switch to their default for the new class (the
   * user's toggle for the old class is dropped). Not persisted.
   */
  setViewport(viewport: ShellViewport): void {
    untrack(() => {
      if (viewport === this.viewport) return;
      this.viewport = viewport;
      let changed = false;
      const panels = { ...(this.settings.panels ?? {}) };
      for (const edge of PANEL_EDGES) {
        const config = this.config.panels[edge];
        const next = config.viewportDefaults?.[viewport];
        if (!next || config.initial === 'hidden') continue;
        if (this.layoutPanels[edge]?.visible === false) continue;
        delete panels[edge];
        changed = true;
        if (next === 'expanded') this.closeExclusivePeers(edge);
        this.panels[edge] = next;
      }
      if (changed) this.settings = { ...this.settings, panels };
      // Docked inline side edges become closed drawers on a phone.
      if (viewport === 'phone') {
        if (this.inlineEdges.left && this.panels.left === 'expanded') {
          this.panels.left = 'collapsed';
        }
      }
      this.applyInline();
    });
  }

  /** How a side edge is presented on phones (`drawer` unless configured). */
  phonePresentation(edge: PanelEdge): PhonePanelPresentation {
    return this.config.panels[edge].phone ?? 'drawer';
  }

  /**
   * How an edge is presented right now: its configured presentation, or
   * `overlay` for a side edge whose `overlayMedia` matches off phones.
   */
  presentationFor(edge: PanelEdge): PanelPresentation {
    const config = this.config.panels[edge];
    if (this.isInline(edge)) return config.presentation;
    if (
      (edge === 'left' || edge === 'right') &&
      this.viewport !== 'phone' &&
      config.overlayMedia &&
      this.overlayMatches[edge]
    ) {
      return 'overlay';
    }
    return config.presentation;
  }

  /**
   * Close side edges that would open as overlays (a restored or initial
   * `expanded` state), without changing the stored preference: an overlay
   * never covers the page on load, while a docked edge still restores.
   */
  closeOverlaidEdges(): void {
    untrack(() => {
      for (const edge of ['left', 'right'] as const) {
        if (
          this.panels[edge] === 'expanded' &&
          this.presentationFor(edge) === 'overlay'
        ) {
          this.panels[edge] = 'collapsed';
        }
      }
    });
  }

  /** Whether an edge is laid out inline (no drop-down) at this viewport. */
  isInline(edge: PanelEdge): boolean {
    // The right edge is the dock: dock toggles and focus tools open it, so it
    // never docks open by itself (it only loses its toggle button and hotkey).
    if (edge === 'right' || !this.inlineEdges[edge]) return false;
    return edge !== 'left' || this.viewport !== 'phone';
  }

  /**
   * Choose which edges are laid out inline. A visible inline side edge is
   * docked open (not persisted); top/bottom keep their band only.
   */
  setInlineEdges(next: Partial<Record<PanelEdge, boolean>>): void {
    untrack(() => {
      const same = PANEL_EDGES.every(
        (edge) => Boolean(this.inlineEdges[edge]) === Boolean(next[edge]),
      );
      if (same) return;
      this.inlineEdges = { ...next };
      this.applyInline();
    });
  }

  private applyInline(): void {
    if (this.isInline('left') && this.panels.left === 'collapsed') {
      this.panels.left = 'expanded';
    }
    // An inline top/bottom edge is its band only: it has no drop-down to open.
    for (const edge of ['top', 'bottom'] as const) {
      if (this.isInline(edge) && this.panels[edge] === 'expanded') {
        this.panels[edge] = 'collapsed';
      }
    }
  }

  /** Record whether a side edge's `overlayMedia` matches. */
  setOverlayMatch(edge: PanelEdge, matches: boolean): void {
    untrack(() => {
      if (Boolean(this.overlayMatches[edge]) === matches) return;
      this.overlayMatches = { ...this.overlayMatches, [edge]: matches };
    });
  }

  /** Whether an edge is rendered at the current viewport. */
  isEdgeShown(edge: PanelEdge): boolean {
    if (this.panels[edge] === 'hidden') return false;
    return !(
      this.viewport === 'phone' && this.phonePresentation(edge) === 'hidden'
    );
  }

  /**
   * Whether a region currently shows its slots: the header and footer unless
   * hidden, a sidebar only while shown and expanded (a collapsed one falls
   * back, see `slotFallbackChain`).
   */
  isRegionVisible(region: ShellRegion): boolean {
    switch (region) {
      case 'header':
        return this.panels.top !== 'hidden';
      case 'footer':
        return this.panels.bottom !== 'hidden';
      case 'leftSidebar':
        return this.isEdgeShown('left') && this.panels.left === 'expanded';
      case 'rightSidebar':
        return this.isEdgeShown('right') && this.panels.right === 'expanded';
    }
  }

  /** Resize limits for an edge, or `null` when it is not resizable. */
  resizeLimits(edge: PanelEdge): Required<ShellPanelResize> | null {
    return resolvePanelResize(edge, this.config.panels[edge]);
  }

  /** The user's resized width for an edge in px, or `null` (configured size). */
  panelSize(edge: PanelEdge): number | null {
    if (!this.resizeLimits(edge)) return null;
    const size = this.settings.sizes?.[edge];
    return typeof size === 'number' && Number.isFinite(size) ? size : null;
  }

  /**
   * Resize an edge's expanded width (px, clamped to its limits); `null`
   * resets it to the configured `expandedSize`. Persisted unless
   * `persist: false` (use that while a drag is in progress) or the edge
   * opts out of storing its size.
   */
  setPanelSize(
    edge: PanelEdge,
    size: number | null,
    options: { persist?: boolean } = {},
  ): void {
    untrack(() => {
      const limits = this.resizeLimits(edge);
      if (!limits) return;
      const next =
        size === null || !Number.isFinite(size)
          ? null
          : clampPanelSize(size, limits);
      this.settings = mergeShellSettingsDelta(this.settings, {
        sizes: { [edge]: next },
      });
      if (options.persist !== false) void this.persistSettings();
    });
  }

  snapshot(): ShellStateSnapshot {
    return {
      panels: { ...this.panels },
      viewport: this.viewport,
      activeFocusToolId: this.activeFocusToolId,
      settings: {
        ...this.settings,
        keymap: this.settings.keymap ? { ...this.settings.keymap } : undefined,
        panels: this.settings.panels ? { ...this.settings.panels } : undefined,
        sizes: this.settings.sizes ? { ...this.settings.sizes } : undefined,
      },
    };
  }

  applySettings(
    delta: ShellSettingsDelta,
    options: { persist?: boolean } = {},
  ): void {
    const nextDelta = snapshotShellSettingsDelta(delta);
    const persist = options.persist;
    untrack(() => {
      this.settings = mergeShellSettingsDelta(this.settings, nextDelta);
      for (const edge of PANEL_EDGES) {
        this.revealed.delete(edge);
        this.panels[edge] = resolveInitialPanelState(
          edge,
          this.config.panels[edge],
          this.settings,
          this.viewport,
          this.layoutPanels[edge],
        );
      }
      this.applyInline();
      this.activeFocusToolId =
        this.settings.activeFocusToolId ?? this.activeFocusToolId;
      if (persist !== false) void this.persistSettings();
    });
  }

  /**
   * Apply the user's per-edge layout overrides. An edge made hidden closes at
   * once; one made visible (or whose `initial` changed) resolves again from
   * its settings, viewport default, layout `initial`, then configured
   * `initial`, so a stored toggle is never discarded by loading a layout.
   * Edges the host configured hidden are untouched.
   */
  setLayoutPanels(next: ShellLayout['panels'] = {}): void {
    untrack(() => {
      const previous = this.layoutPanels;
      this.layoutPanels = { ...next };
      for (const edge of PANEL_EDGES) {
        const before = previous[edge];
        const after = next[edge];
        if (
          before?.visible === after?.visible &&
          before?.initial === after?.initial
        ) {
          continue;
        }
        const config = this.config.panels[edge];
        if (config.initial === 'hidden') continue;
        this.revealed.delete(edge);
        this.panels[edge] = resolveInitialPanelState(
          edge,
          config,
          this.settings,
          this.viewport,
          after,
        );
        if (this.panels[edge] === 'expanded') this.closeExclusivePeers(edge);
      }
      this.applyInline();
    });
  }

  /**
   * Make `state` an edge's state now and for later loads: the user chose its
   * starting state, so a stored open/closed toggle is dropped. Not applied to
   * hidden edges or edges whose state follows the viewport.
   */
  setPanelStart(edge: PanelEdge, state: VisiblePanelState): void {
    untrack(() => {
      const config = this.config.panels[edge];
      if (
        config.initial === 'hidden' ||
        config.viewportDefaults ||
        this.layoutPanels[edge]?.visible === false
      ) {
        return;
      }
      if (this.settings.panels && edge in this.settings.panels) {
        const { [edge]: _dropped, ...rest } = this.settings.panels;
        this.settings = { ...this.settings, panels: rest };
      }
      if (state === 'expanded') this.closeExclusivePeers(edge);
      this.revealed.delete(edge);
      this.panels[edge] = state;
      this.applyInline();
      void this.persistSettings();
    });
  }

  /**
   * Store the user's shell layout in the settings core (an empty layout
   * clears it). `AppShell` does this only when the host passes neither
   * `layout` nor `onlayoutchange`.
   */
  setLayout(layout: ShellLayout | null): void {
    untrack(() => {
      const { layout: _previous, ...rest } = this.settings;
      this.settings =
        layout && !isShellLayoutEmpty(layout) ? { ...rest, layout } : rest;
      void this.persistSettings();
    });
  }

  setHotkeysEnabled(enabled: boolean): void {
    untrack(() => this.applySettings({ hotkeysEnabled: enabled }));
  }

  setHotkey(edge: PanelEdge, code: string | null): void {
    untrack(() => {
      this.applySettings({
        keymap: {
          [edge]: code ? { code } : null,
        },
      });
    });
  }

  setPanel(edge: PanelEdge, state: VisiblePanelState): void {
    this.setPanelState(edge, state);
  }

  /** Set and persist a runtime panel preference, including hidden. */
  setPanelState(edge: PanelEdge, state: PanelState): void {
    if (
      !PANEL_EDGES.includes(edge) ||
      !['hidden', 'collapsed', 'expanded'].includes(state)
    )
      return;
    untrack(() => {
      if (
        this.config.panels[edge].initial === 'hidden' ||
        this.layoutPanels[edge]?.visible === false
      ) {
        this.panels[edge] = 'hidden';
        return;
      }
      // An inline side edge is always docked open; closing it is a no-op.
      if (this.isInline(edge)) {
        const side = edge === 'left';
        if (side && state === 'collapsed') state = 'expanded';
        if (!side && state === 'expanded') state = 'collapsed';
      }
      if (state === 'expanded') this.closeExclusivePeers(edge);
      this.revealed.delete(edge);
      this.panels[edge] = state;
      this.settings = mergeShellSettingsDelta(this.settings, {
        panels: { [edge]: state },
      });
      void this.persistSettings();
    });
  }

  /**
   * Open a collapsed, shown sidebar for now only: nothing is written to the
   * settings or the adapter, so a reload (or a page that unloads meanwhile)
   * finds the user's own state. Returns whether it opened. An explicit
   * change of that edge (toggle, `setPanelState`, a new starting state)
   * makes it the user's, and `endTemporaryReveal` then leaves it alone.
   */
  revealPanelTemporarily(edge: PanelEdge): boolean {
    return untrack(() => {
      if (!this.isEdgeShown(edge) || this.panels[edge] !== 'collapsed') {
        return false;
      }
      this.panels[edge] = 'expanded';
      this.revealed.add(edge);
      return true;
    });
  }

  /** Close an edge opened by `revealPanelTemporarily`, without saving. */
  endTemporaryReveal(edge: PanelEdge): void {
    untrack(() => {
      if (!this.revealed.delete(edge)) return;
      if (this.panels[edge] === 'expanded') this.panels[edge] = 'collapsed';
    });
  }

  togglePanel(edge: PanelEdge): void {
    untrack(() => {
      if (this.panels[edge] === 'hidden') return;
      this.setPanel(
        edge,
        this.panels[edge] === 'expanded' ? 'collapsed' : 'expanded',
      );
    });
  }

  expandPanel(edge: PanelEdge): void {
    untrack(() => this.setPanel(edge, 'expanded'));
  }

  collapsePanel(edge: PanelEdge): void {
    untrack(() => this.setPanel(edge, 'collapsed'));
  }

  closeTopmostExpanded(): boolean {
    return untrack(() => {
      for (const edge of [...PANEL_EDGES].reverse()) {
        if (this.isInline(edge)) continue;
        if (this.panels[edge] === 'expanded' && this.isEdgeShown(edge)) {
          this.collapsePanel(edge);
          return true;
        }
      }
      return false;
    });
  }

  registerFocusTool(tool: ShellFocusTool): () => void {
    const nextTool = snapshotFocusTool(tool);
    return untrack(() => {
      this.focusTools = [
        ...this.focusTools.filter((existing) => existing.id !== nextTool.id),
        nextTool,
      ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (!this.activeFocusToolId) this.activeFocusToolId = nextTool.id;
      return () => this.unregisterFocusTool(nextTool.id);
    });
  }

  unregisterFocusTool(id: string): void {
    untrack(() => {
      this.focusTools = this.focusTools.filter((tool) => tool.id !== id);
      if (this.activeFocusToolId === id) {
        this.activeFocusToolId = this.focusTools[0]?.id ?? null;
      }
    });
  }

  openFocusTool(id: string): void {
    untrack(() => {
      if (!this.focusTools.some((tool) => tool.id === id)) return;
      this.activeFocusToolId = id;
      this.settings = mergeShellSettingsDelta(this.settings, {
        activeFocusToolId: id,
      });
      this.expandPanel('right');
      void this.persistSettings();
    });
  }

  toggleFocusTool(id: string): void {
    untrack(() => {
      if (!this.focusTools.some((tool) => tool.id === id)) return;
      if (this.activeFocusToolId === id && this.panels.right === 'expanded') {
        this.collapsePanel('right');
        return;
      }
      this.openFocusTool(id);
    });
  }

  /**
   * The focus tool currently shown in the open right edge (the dock), or
   * `null` while the edge is collapsed or hidden.
   */
  get openFocusToolId(): string | null {
    return this.panels.right === 'expanded' && this.isEdgeShown('right')
      ? this.activeFocusToolId
      : null;
  }

  /**
   * Whether the dock (right edge) can be shown now: not removed by the host
   * (including `phone: 'hidden'` on a phone) and not hidden by the user's
   * layout.
   */
  get dockAvailable(): boolean {
    return (
      this.config.panels.right.initial !== 'hidden' &&
      this.layoutPanels.right?.visible !== false &&
      !(
        this.viewport === 'phone' &&
        this.phonePresentation('right') === 'hidden'
      )
    );
  }

  /** Close the dock (collapse the right edge). */
  closeFocusTool(): void {
    this.collapsePanel('right');
  }

  /**
   * Open a dock tool and ask for focus to move into it. `returnFocus` is
   * where focus goes back to when the dock closes (default: whatever has
   * focus now). Returns false when no such tool is registered or the dock is
   * not available (see `dockAvailable`).
   */
  openDockTool(id: string, options: ShellDockOpenOptions = {}): boolean {
    return untrack(() => {
      if (!this.focusTools.some((tool) => tool.id === id)) return false;
      if (!this.dockAvailable) return false;
      this.openFocusTool(id);
      if (options.focus === false) return true;
      const active =
        typeof document === 'undefined' ? null : document.activeElement;
      this.dockReturnFocus =
        options.returnFocus ??
        (active instanceof HTMLElement && active !== document.body
          ? active
          : null);
      this.dockFocusRequest += 1;
      return true;
    });
  }

  /** Toggle a dock tool; opening it follows `openDockTool`. */
  toggleDockTool(id: string, options: ShellDockOpenOptions = {}): boolean {
    return untrack(() => {
      if (!this.focusTools.some((tool) => tool.id === id)) return false;
      if (!this.dockAvailable) return false;
      if (this.openFocusToolId === id) {
        this.closeFocusTool();
        return true;
      }
      return this.openDockTool(id, options);
    });
  }

  upsertActivity(activity: ShellActivity): void {
    const nextActivity = snapshotActivity(activity);
    untrack(() => {
      const now = new Date().toISOString();
      const normalized: ShellActivity = {
        ...nextActivity,
        edge: nextActivity.edge ?? this.homeEdgeForScope(nextActivity.scope),
        createdAt: nextActivity.createdAt ?? now,
        updatedAt: nextActivity.updatedAt ?? now,
      };
      const previous = this.activities.find(
        (item) => item.id === nextActivity.id,
      );
      this.activities = [
        ...this.activities.filter((item) => item.id !== nextActivity.id),
        normalized,
      ];
      this.emitActivity({
        type:
          previous && previous.status !== normalized.status
            ? 'transition'
            : 'upsert',
        activity: normalized,
        previous,
      });
    });
  }

  updateActivity(id: string, patch: ShellActivityPatch): void {
    const nextPatch = snapshotActivityPatch(patch);
    untrack(() => {
      const current = this.activities.find((activity) => activity.id === id);
      if (!current) return;
      this.upsertActivity({
        ...current,
        ...nextPatch,
        id,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  removeActivity(id: string): void {
    untrack(() => {
      const current = this.activities.find((activity) => activity.id === id);
      if (!current) return;
      this.activities = this.activities.filter(
        (activity) => activity.id !== id,
      );
      this.emitActivity({ type: 'remove', activity: current });
    });
  }

  watchActivities(listener: ActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  listActivities(filter: ShellActivityFilter = {}): ShellActivity[] {
    return this.activities
      .map((activity) => ({
        ...activity,
        edge: activity.edge ?? this.homeEdgeForScope(activity.scope),
      }))
      .filter((activity) => activityMatchesFilter(activity, filter));
  }

  activityBadge(edge: PanelEdge): ShellActivityBadge {
    const activities = this.listActivities({ edge }).filter((activity) =>
      isActiveStatus(activity.status),
    );
    const determinate = activities
      .map((activity) => activity.progress)
      .filter((progress): progress is number => typeof progress === 'number');
    return {
      count: activities.length,
      running: activities.filter((activity) => activity.status === 'running')
        .length,
      hasFailed: this.listActivities({ edge }).some(
        (activity) => activity.status === 'failed',
      ),
      progress:
        determinate.length === 0
          ? null
          : determinate.reduce((total, progress) => total + progress, 0) /
            determinate.length,
    };
  }

  homeEdgeForScope(scope: ShellScope): PanelEdge {
    const preferred = SCOPE_EDGES[scope];
    if (this.panels[preferred] !== 'hidden') return preferred;
    if (this.panels.bottom !== 'hidden') return 'bottom';
    // Both the scope's edge and System are hidden — fall back to any visible
    // edge so the activity still surfaces somewhere rather than homing to a
    // hidden edge where its badge never renders.
    const visible = PANEL_EDGES.find((edge) => this.panels[edge] !== 'hidden');
    return visible ?? preferred;
  }

  private closeExclusivePeers(edge: PanelEdge): void {
    const group = this.config.panels[edge].exclusiveGroup;
    if (!group) return;
    for (const peer of PANEL_EDGES) {
      if (
        peer !== edge &&
        this.config.panels[peer].exclusiveGroup === group &&
        this.panels[peer] === 'expanded'
      ) {
        this.panels[peer] = 'collapsed';
        // Persist the peer collapse too, otherwise its stale 'expanded' delta
        // survives and both panels reopen on reload, defeating exclusivity.
        this.settings = mergeShellSettingsDelta(this.settings, {
          panels: { [peer]: 'collapsed' },
        });
      }
    }
  }

  private async persistSettings(): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.write(
      stripUnpersistedSettings(this.settings, this.config),
    );
  }

  private emitActivity(event: ShellActivityEvent): void {
    for (const listener of this.activityListeners) listener(event);
  }
}

export function createShellState(options: ShellStateOptions = {}): ShellState {
  return new ShellState(options);
}

function activityMatchesFilter(
  activity: ShellActivity,
  filter: ShellActivityFilter,
): boolean {
  if (filter.edge && activity.edge !== filter.edge) return false;
  if (filter.scope && activity.scope !== filter.scope) return false;
  if (filter.kind && !matchesOne(activity.kind, filter.kind)) return false;
  if (filter.status && !matchesOne(activity.status, filter.status)) {
    return false;
  }
  if (filter.subject) {
    return (
      activity.subject?.type === filter.subject.type &&
      activity.subject.id === filter.subject.id
    );
  }
  return true;
}

function matchesOne<T extends string>(value: T, expected: T | T[]): boolean {
  return Array.isArray(expected)
    ? expected.includes(value)
    : value === expected;
}

function isActiveStatus(status: ActivityStatus): boolean {
  return status === 'queued' || status === 'running';
}

function snapshotShellSettingsDelta(
  delta: ShellSettingsDelta,
): ShellSettingsDelta {
  const snapshot: ShellSettingsDelta = { ...delta };
  if ('keymap' in delta) {
    snapshot.keymap = snapshotShellKeymap(delta.keymap);
  }
  if ('panels' in delta) {
    snapshot.panels = delta.panels ? { ...delta.panels } : delta.panels;
  }
  if ('sizes' in delta) {
    snapshot.sizes = delta.sizes ? { ...delta.sizes } : delta.sizes;
  }
  return snapshot;
}

function snapshotShellKeymap(
  keymap: ShellSettingsDelta['keymap'],
): ShellSettingsDelta['keymap'] {
  if (!keymap) return keymap;
  const snapshot: ShellSettingsDelta['keymap'] = {};
  for (const edge of PANEL_EDGES) {
    if (edge in keymap) {
      const binding = keymap[edge];
      snapshot[edge] = binding ? { ...binding } : binding;
    }
  }
  return snapshot;
}

function snapshotFocusTool(tool: ShellFocusTool): ShellFocusTool {
  const snapshot: ShellFocusTool = { ...tool };
  if ('subject' in tool) {
    snapshot.subject = tool.subject ? { ...tool.subject } : tool.subject;
  }
  if ('activityKinds' in tool) {
    snapshot.activityKinds = tool.activityKinds
      ? [...tool.activityKinds]
      : tool.activityKinds;
  }
  return snapshot;
}

function snapshotActivity(activity: ShellActivity): ShellActivity {
  const snapshot: ShellActivity = { ...activity };
  if ('subject' in activity) {
    snapshot.subject = activity.subject
      ? { ...activity.subject }
      : activity.subject;
  }
  return snapshot;
}

function snapshotActivityPatch(patch: ShellActivityPatch): ShellActivityPatch {
  const snapshot: ShellActivityPatch = { ...patch };
  if ('subject' in patch) {
    snapshot.subject = patch.subject ? { ...patch.subject } : patch.subject;
  }
  return snapshot;
}
