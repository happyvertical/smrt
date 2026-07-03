import type { Component, Snippet } from 'svelte';

export type PanelEdge = 'top' | 'left' | 'right' | 'bottom';
export type ShellScope = 'app' | 'tenant' | 'focus' | 'system';
export type PanelState = 'hidden' | 'collapsed' | 'expanded';
export type VisiblePanelState = Exclude<PanelState, 'hidden'>;
export type PanelPresentation = 'push' | 'overlay';
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
}

export type ShellPanelDefaults = Partial<
  Record<PanelEdge, Partial<ShellPanelConfig> | false>
>;

export interface ShellSettingsDelta {
  hotkeysEnabled?: boolean;
  keymap?: Partial<Record<PanelEdge, ShellHotkeyBinding | null>>;
  panels?: Partial<Record<PanelEdge, VisiblePanelState>>;
  activeFocusToolId?: string | null;
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

export interface ShellNavItem {
  href: string;
  label: string;
  icon?: string;
  description?: string;
  badge?: number | string | null;
  children?: ShellNavItem[];
}

export interface ShellFocusTool {
  id: string;
  label: string;
  description?: string;
  order?: number;
  badge?: number | string | null;
  component?: Component | null;
  render?: Snippet<[{ tool: ShellFocusTool }]>;
  scopeId?: string;
  subject?: ShellFocusToolSubject;
  activityKinds?: string[];
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
  activeFocusToolId: string | null;
  settings: ShellSettingsDelta;
}

export interface AdminShellProps {
  title?: string;
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
