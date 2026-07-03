import {
  LocalStorageShellSettingsAdapter,
  mergeShellSettingsDelta,
  resolveInitialPanelState,
  resolveShellConfig,
} from './settings.js';
import type {
  ActivityStatus,
  PanelEdge,
  PanelState,
  ResolvedShellConfig,
  ShellActivity,
  ShellActivityBadge,
  ShellActivityEvent,
  ShellActivityFilter,
  ShellFocusTool,
  ShellPanelDefaults,
  ShellScope,
  ShellSettingsAdapter,
  ShellSettingsDelta,
  ShellStateSnapshot,
  VisiblePanelState,
} from './types.js';
import { PANEL_EDGES, SCOPE_EDGES } from './types.js';

type ActivityListener = (event: ShellActivityEvent) => void;

export interface ShellStateOptions {
  config?: ShellPanelDefaults;
  settings?: ShellSettingsDelta;
  settingsAdapter?: ShellSettingsAdapter;
  storageKey?: string;
}

export class ShellState {
  readonly config: ResolvedShellConfig;
  readonly adapter: ShellSettingsAdapter | null;

  settings = $state<ShellSettingsDelta>({});
  panels = $state<Record<PanelEdge, PanelState>>({
    top: 'collapsed',
    left: 'collapsed',
    right: 'collapsed',
    bottom: 'collapsed',
  });
  focusTools = $state<ShellFocusTool[]>([]);
  activeFocusToolId = $state<string | null>(null);
  activities = $state<ShellActivity[]>([]);

  private activityListeners = new Set<ActivityListener>();

  constructor(options: ShellStateOptions = {}) {
    this.config = resolveShellConfig(options.config);
    this.adapter =
      options.settingsAdapter ??
      (options.storageKey
        ? new LocalStorageShellSettingsAdapter(options.storageKey)
        : null);
    this.applySettings(options.settings ?? {}, { persist: false });
  }

  async hydrate(): Promise<void> {
    if (!this.adapter) return;
    const delta = await this.adapter.read();
    if (delta) this.applySettings(delta, { persist: false });
  }

  snapshot(): ShellStateSnapshot {
    return {
      panels: { ...this.panels },
      activeFocusToolId: this.activeFocusToolId,
      settings: {
        ...this.settings,
        keymap: this.settings.keymap ? { ...this.settings.keymap } : undefined,
        panels: this.settings.panels ? { ...this.settings.panels } : undefined,
      },
    };
  }

  applySettings(
    delta: ShellSettingsDelta,
    options: { persist?: boolean } = {},
  ): void {
    this.settings = mergeShellSettingsDelta(this.settings, delta);
    for (const edge of PANEL_EDGES) {
      this.panels[edge] = resolveInitialPanelState(
        edge,
        this.config.panels[edge],
        this.settings,
      );
    }
    this.activeFocusToolId =
      this.settings.activeFocusToolId ?? this.activeFocusToolId;
    if (options.persist !== false) void this.persistSettings();
  }

  setHotkeysEnabled(enabled: boolean): void {
    this.applySettings({ hotkeysEnabled: enabled });
  }

  setHotkey(edge: PanelEdge, code: string | null): void {
    this.applySettings({
      keymap: {
        [edge]: code ? { code } : null,
      },
    });
  }

  setPanel(edge: PanelEdge, state: VisiblePanelState): void {
    if (this.config.panels[edge].initial === 'hidden') {
      this.panels[edge] = 'hidden';
      return;
    }
    if (state === 'expanded') this.closeExclusivePeers(edge);
    this.panels[edge] = state;
    this.settings = mergeShellSettingsDelta(this.settings, {
      panels: { [edge]: state },
    });
    void this.persistSettings();
  }

  togglePanel(edge: PanelEdge): void {
    if (this.panels[edge] === 'hidden') return;
    this.setPanel(
      edge,
      this.panels[edge] === 'expanded' ? 'collapsed' : 'expanded',
    );
  }

  expandPanel(edge: PanelEdge): void {
    this.setPanel(edge, 'expanded');
  }

  collapsePanel(edge: PanelEdge): void {
    this.setPanel(edge, 'collapsed');
  }

  closeTopmostExpanded(): boolean {
    for (const edge of [...PANEL_EDGES].reverse()) {
      if (this.panels[edge] === 'expanded') {
        this.collapsePanel(edge);
        return true;
      }
    }
    return false;
  }

  registerFocusTool(tool: ShellFocusTool): () => void {
    this.focusTools = [
      ...this.focusTools.filter((existing) => existing.id !== tool.id),
      tool,
    ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!this.activeFocusToolId) this.activeFocusToolId = tool.id;
    return () => this.unregisterFocusTool(tool.id);
  }

  unregisterFocusTool(id: string): void {
    this.focusTools = this.focusTools.filter((tool) => tool.id !== id);
    if (this.activeFocusToolId === id) {
      this.activeFocusToolId = this.focusTools[0]?.id ?? null;
    }
  }

  openFocusTool(id: string): void {
    if (!this.focusTools.some((tool) => tool.id === id)) return;
    this.activeFocusToolId = id;
    this.settings = mergeShellSettingsDelta(this.settings, {
      activeFocusToolId: id,
    });
    this.expandPanel('right');
    void this.persistSettings();
  }

  upsertActivity(activity: ShellActivity): void {
    const now = new Date().toISOString();
    const normalized: ShellActivity = {
      ...activity,
      edge: activity.edge ?? this.homeEdgeForScope(activity.scope),
      createdAt: activity.createdAt ?? now,
      updatedAt: activity.updatedAt ?? now,
    };
    const previous = this.activities.find((item) => item.id === activity.id);
    this.activities = [
      ...this.activities.filter((item) => item.id !== activity.id),
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
  }

  updateActivity(id: string, patch: Partial<Omit<ShellActivity, 'id'>>): void {
    const current = this.activities.find((activity) => activity.id === id);
    if (!current) return;
    this.upsertActivity({
      ...current,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
  }

  removeActivity(id: string): void {
    const current = this.activities.find((activity) => activity.id === id);
    if (!current) return;
    this.activities = this.activities.filter((activity) => activity.id !== id);
    this.emitActivity({ type: 'remove', activity: current });
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
    await this.adapter?.write(this.settings);
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
