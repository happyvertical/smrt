import {
  isShellLayoutEmpty,
  normalizeShellLayout,
  type ShellLayoutPanel,
} from './layout.js';
import type {
  PanelEdge,
  PanelState,
  ResolvedShellConfig,
  ShellHotkeyBinding,
  ShellPanelConfig,
  ShellPanelDefaults,
  ShellPanelResize,
  ShellSettingsAdapter,
  ShellSettingsDelta,
  ShellViewport,
} from './types.js';
import { EDGE_SCOPES, PANEL_EDGES } from './types.js';

export const DEFAULT_SHELL_KEYMAP: Record<PanelEdge, ShellHotkeyBinding> = {
  top: { code: 'KeyW' },
  left: { code: 'KeyA' },
  bottom: { code: 'KeyS' },
  right: { code: 'KeyD' },
};

const DEFAULT_PANEL_CONFIG: Record<PanelEdge, ShellPanelConfig> = {
  top: {
    edge: 'top',
    scope: 'app',
    label: 'Header',
    initial: 'collapsed',
    presentation: 'overlay',
    hotkey: DEFAULT_SHELL_KEYMAP.top,
    collapsedSize: '3.5rem',
    expandedSize: '18rem',
  },
  left: {
    edge: 'left',
    scope: 'tenant',
    label: 'Left sidebar',
    initial: 'collapsed',
    presentation: 'push',
    hotkey: DEFAULT_SHELL_KEYMAP.left,
    collapsedSize: '4.25rem',
    expandedSize: '16rem',
  },
  right: {
    edge: 'right',
    scope: 'focus',
    label: 'Right sidebar',
    initial: 'collapsed',
    presentation: 'push',
    hotkey: DEFAULT_SHELL_KEYMAP.right,
    collapsedSize: '4.25rem',
    expandedSize: '20rem',
  },
  bottom: {
    edge: 'bottom',
    scope: 'system',
    label: 'Footer',
    initial: 'collapsed',
    presentation: 'overlay',
    hotkey: DEFAULT_SHELL_KEYMAP.bottom,
    collapsedSize: '2.75rem',
    expandedSize: '18rem',
  },
};

export function resolveShellConfig(
  appDefaults: ShellPanelDefaults = {},
): ResolvedShellConfig {
  const panels = Object.fromEntries(
    PANEL_EDGES.map((edge) => {
      const override = appDefaults[edge];
      if (override === false) {
        return [
          edge,
          {
            ...DEFAULT_PANEL_CONFIG[edge],
            initial: 'hidden' as const,
            hotkey: null,
          },
        ];
      }
      return [
        edge,
        {
          ...DEFAULT_PANEL_CONFIG[edge],
          ...override,
          edge,
          scope: override?.scope ?? EDGE_SCOPES[edge],
        },
      ];
    }),
  ) as Record<PanelEdge, ShellPanelConfig>;

  return { panels };
}

/**
 * An edge's state: hidden edges (by the host or the user's layout) stay
 * hidden; otherwise the user's setting, then the edge's default for
 * `viewport` (when it declares `viewportDefaults`), then the layout's
 * `initial`, then the configured initial state.
 */
export function resolveInitialPanelState(
  edge: PanelEdge,
  config: ShellPanelConfig,
  settings: ShellSettingsDelta = {},
  viewport?: ShellViewport,
  layoutPanel?: ShellLayoutPanel,
): PanelState {
  if (config.initial === 'hidden') return 'hidden';
  if (layoutPanel?.visible === false) return 'hidden';
  return (
    settings.panels?.[edge] ??
    (viewport ? config.viewportDefaults?.[viewport] : undefined) ??
    layoutPanel?.initial ??
    config.initial
  );
}

/** Default limits for a resizable side edge (CSS px). */
export const DEFAULT_SHELL_PANEL_RESIZE: Required<ShellPanelResize> = {
  min: 240,
  max: 720,
  step: 16,
};

/**
 * Resolved resize limits for an edge, or `null` when it is not resizable.
 * Only `left` and `right` edges resize.
 */
export function resolvePanelResize(
  edge: PanelEdge,
  config: ShellPanelConfig,
): Required<ShellPanelResize> | null {
  if (edge !== 'left' && edge !== 'right') return null;
  if (!config.resizable || config.initial === 'hidden') return null;
  const limits = config.resizable === true ? {} : config.resizable;
  const min = Math.max(0, limits.min ?? DEFAULT_SHELL_PANEL_RESIZE.min);
  return {
    min,
    max: Math.max(min, limits.max ?? DEFAULT_SHELL_PANEL_RESIZE.max),
    step: Math.max(1, limits.step ?? DEFAULT_SHELL_PANEL_RESIZE.step),
  };
}

/** Clamp a requested width into an edge's resize limits (rounded to px). */
export function clampPanelSize(
  size: number,
  limits: Required<ShellPanelResize>,
): number {
  return Math.round(Math.min(limits.max, Math.max(limits.min, size)));
}

/**
 * Whether the settings adapter stores an edge's `state` (open/closed) or
 * `size`. Edges with `viewportDefaults` never store their state: it follows
 * the viewport class.
 */
export function panelPersists(
  config: ShellPanelConfig,
  what: 'state' | 'size',
): boolean {
  if (what === 'state' && config.viewportDefaults) return false;
  const persist = config.persist ?? true;
  if (typeof persist === 'boolean') return persist;
  return persist[what] ?? true;
}

/**
 * Drop the panel states and sizes the config says not to store, so they are
 * neither written by nor read back from a settings adapter.
 */
export function stripUnpersistedSettings(
  delta: ShellSettingsDelta,
  config: ResolvedShellConfig,
): ShellSettingsDelta {
  const stripped: ShellSettingsDelta = { ...delta };
  for (const key of ['panels', 'sizes'] as const) {
    const values = delta[key];
    if (!values) continue;
    const kept: Record<string, unknown> = {};
    for (const edge of PANEL_EDGES) {
      if (!(edge in values)) continue;
      if (
        panelPersists(config.panels[edge], key === 'panels' ? 'state' : 'size')
      ) {
        kept[edge] = values[edge];
      }
    }
    if (Object.keys(kept).length > 0) {
      (stripped as Record<string, unknown>)[key] = kept;
    } else {
      delete stripped[key];
    }
  }
  return stripped;
}

export function resolveHotkey(
  edge: PanelEdge,
  config: ShellPanelConfig,
  settings: ShellSettingsDelta = {},
): ShellHotkeyBinding | null {
  if (config.initial === 'hidden') return null;
  if (settings.keymap && edge in settings.keymap) {
    return settings.keymap[edge] ?? null;
  }
  return config.hotkey;
}

export function mergeShellSettingsDelta(
  base: ShellSettingsDelta,
  next: ShellSettingsDelta,
): ShellSettingsDelta {
  return {
    ...base,
    ...next,
    keymap:
      base.keymap || next.keymap
        ? { ...(base.keymap ?? {}), ...(next.keymap ?? {}) }
        : undefined,
    panels:
      base.panels || next.panels
        ? { ...(base.panels ?? {}), ...(next.panels ?? {}) }
        : undefined,
    sizes:
      base.sizes || next.sizes
        ? { ...(base.sizes ?? {}), ...(next.sizes ?? {}) }
        : undefined,
  };
}

export function pruneShellSettingsDelta(
  delta: ShellSettingsDelta,
): ShellSettingsDelta {
  const pruned: ShellSettingsDelta = {};
  if (delta.hotkeysEnabled !== undefined) {
    pruned.hotkeysEnabled = delta.hotkeysEnabled;
  }
  if (delta.activeFocusToolId !== undefined) {
    pruned.activeFocusToolId = delta.activeFocusToolId;
  }
  if (delta.layout !== undefined) {
    const layout = normalizeShellLayout(delta.layout);
    if (!isShellLayoutEmpty(layout)) pruned.layout = layout;
  }
  if (delta.keymap && Object.keys(delta.keymap).length > 0) {
    pruned.keymap = delta.keymap;
  }
  if (delta.panels && Object.keys(delta.panels).length > 0) {
    pruned.panels = delta.panels;
  }
  if (delta.sizes) {
    const sizes = Object.fromEntries(
      Object.entries(delta.sizes).filter(
        ([, size]) => typeof size === 'number' && Number.isFinite(size),
      ),
    );
    if (Object.keys(sizes).length > 0) pruned.sizes = sizes;
  }
  return pruned;
}

export class LocalStorageShellSettingsAdapter implements ShellSettingsAdapter {
  constructor(private readonly key: string) {}

  read(): ShellSettingsDelta | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return null;
      return JSON.parse(raw) as ShellSettingsDelta;
    } catch {
      return null;
    }
  }

  write(delta: ShellSettingsDelta): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      this.key,
      JSON.stringify(pruneShellSettingsDelta(delta)),
    );
  }
}
