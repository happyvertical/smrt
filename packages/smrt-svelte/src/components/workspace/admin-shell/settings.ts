import type {
  PanelEdge,
  PanelState,
  ResolvedShellConfig,
  ShellHotkeyBinding,
  ShellPanelConfig,
  ShellPanelDefaults,
  ShellSettingsAdapter,
  ShellSettingsDelta,
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
    label: 'App',
    initial: 'collapsed',
    presentation: 'overlay',
    hotkey: DEFAULT_SHELL_KEYMAP.top,
    collapsedSize: '3.5rem',
    expandedSize: '18rem',
  },
  left: {
    edge: 'left',
    scope: 'tenant',
    label: 'Tenant',
    initial: 'collapsed',
    presentation: 'push',
    hotkey: DEFAULT_SHELL_KEYMAP.left,
    collapsedSize: '4.25rem',
    expandedSize: '16rem',
  },
  right: {
    edge: 'right',
    scope: 'focus',
    label: 'Focus',
    initial: 'collapsed',
    presentation: 'push',
    hotkey: DEFAULT_SHELL_KEYMAP.right,
    collapsedSize: '4.25rem',
    expandedSize: '20rem',
  },
  bottom: {
    edge: 'bottom',
    scope: 'system',
    label: 'System',
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

export function resolveInitialPanelState(
  edge: PanelEdge,
  config: ShellPanelConfig,
  settings: ShellSettingsDelta = {},
): PanelState {
  if (config.initial === 'hidden') return 'hidden';
  return settings.panels?.[edge] ?? config.initial;
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
  if (delta.keymap && Object.keys(delta.keymap).length > 0) {
    pruned.keymap = delta.keymap;
  }
  if (delta.panels && Object.keys(delta.panels).length > 0) {
    pruned.panels = delta.panels;
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
