/**
 * ShellState's viewport defaults, resizable-edge sizes, and per-edge
 * persistence opt-outs.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  panelPersists,
  pruneShellSettingsDelta,
  resolvePanelResize,
  resolveShellConfig,
  stripUnpersistedSettings,
} from '../admin-shell/settings.js';
import { createShellState } from '../admin-shell/state.svelte.js';
import type { ShellSettingsDelta } from '../admin-shell/types.js';

function adapter(initial: ShellSettingsDelta | null = null) {
  const writes: ShellSettingsDelta[] = [];
  return {
    writes,
    read: vi.fn(() => initial),
    write: vi.fn((delta: ShellSettingsDelta) => {
      writes.push(JSON.parse(JSON.stringify(delta)));
    }),
  };
}

const navDefaults = {
  phone: 'collapsed',
  tablet: 'collapsed',
  desktop: 'expanded',
} as const;

describe('viewport defaults', () => {
  it('uses the default for the initial viewport', () => {
    const phone = createShellState({
      viewport: 'phone',
      config: { left: { viewportDefaults: navDefaults } },
    });
    expect(phone.panels.left).toBe('collapsed');
    const desktop = createShellState({
      viewport: 'desktop',
      config: { left: { viewportDefaults: navDefaults } },
    });
    expect(desktop.panels.left).toBe('expanded');
  });

  it('applies the new default only when the viewport class changes', () => {
    const shell = createShellState({
      viewport: 'desktop',
      config: { left: { viewportDefaults: navDefaults } },
    });
    shell.collapsePanel('left');
    shell.setViewport('desktop');
    expect(shell.panels.left).toBe('collapsed');
    shell.setViewport('tablet');
    expect(shell.viewport).toBe('tablet');
    expect(shell.panels.left).toBe('collapsed');
    shell.expandPanel('left');
    shell.setViewport('desktop');
    expect(shell.panels.left).toBe('expanded');
    // A later settings merge does not resurrect the old class's toggle.
    shell.applySettings({ activeFocusToolId: 'x' });
    expect(shell.panels.left).toBe('expanded');
  });

  it('never persists the state of an edge that follows the viewport', async () => {
    const store = adapter({ panels: { left: 'expanded', right: 'expanded' } });
    const shell = createShellState({
      viewport: 'phone',
      config: { left: { viewportDefaults: navDefaults } },
      settingsAdapter: store,
    });
    await shell.hydrate();
    expect(shell.panels.left).toBe('collapsed');
    expect(shell.panels.right).toBe('expanded');
    shell.expandPanel('left');
    expect(store.writes.at(-1)?.panels).toEqual({ right: 'expanded' });
  });

  it('leaves edges without viewport defaults alone (backward compatible)', () => {
    const shell = createShellState({ viewport: 'desktop' });
    shell.expandPanel('left');
    shell.setViewport('phone');
    expect(shell.panels.left).toBe('expanded');
    expect(shell.snapshot().viewport).toBe('phone');
  });
});

describe('phone presentation', () => {
  it('hides a phone-hidden edge only on phones, and Escape skips it there', () => {
    const shell = createShellState({
      viewport: 'phone',
      config: { right: { phone: 'hidden', initial: 'expanded' } },
    });
    expect(shell.phonePresentation('right')).toBe('hidden');
    expect(shell.phonePresentation('left')).toBe('drawer');
    expect(shell.isEdgeShown('right')).toBe(false);
    expect(shell.closeTopmostExpanded()).toBe(false);
    expect(shell.panels.right).toBe('expanded');
    shell.setViewport('desktop');
    expect(shell.isEdgeShown('right')).toBe(true);
    expect(shell.closeTopmostExpanded()).toBe(true);
    expect(shell.panels.right).toBe('collapsed');
  });
});

describe('resizable edges', () => {
  it('resolves limits for side edges only', () => {
    const config = resolveShellConfig({
      right: { resizable: { min: 300, max: 600 } },
      left: { resizable: true },
      top: { resizable: true },
    });
    expect(resolvePanelResize('right', config.panels.right)).toEqual({
      min: 300,
      max: 600,
      step: 16,
    });
    expect(resolvePanelResize('left', config.panels.left)).toEqual({
      min: 240,
      max: 720,
      step: 16,
    });
    expect(resolvePanelResize('top', config.panels.top)).toBeNull();
    expect(resolvePanelResize('bottom', config.panels.bottom)).toBeNull();
  });

  it('clamps, persists, and resets sizes', () => {
    const store = adapter();
    const shell = createShellState({
      config: { right: { resizable: { min: 300, max: 600 } } },
      settingsAdapter: store,
    });
    expect(shell.panelSize('right')).toBeNull();
    shell.setPanelSize('right', 900);
    expect(shell.panelSize('right')).toBe(600);
    expect(store.writes.at(-1)?.sizes).toEqual({ right: 600 });
    shell.setPanelSize('right', 120.4, { persist: false });
    expect(shell.panelSize('right')).toBe(300);
    expect(store.write).toHaveBeenCalledTimes(1);
    shell.setPanelSize('right', null);
    expect(shell.panelSize('right')).toBeNull();
    expect(pruneShellSettingsDelta(shell.settings).sizes).toBeUndefined();
  });

  it('ignores sizes for edges that are not resizable', () => {
    const shell = createShellState({ settings: { sizes: { left: 500 } } });
    expect(shell.panelSize('left')).toBeNull();
    shell.setPanelSize('left', 400);
    expect(shell.settings.sizes).toEqual({ left: 500 });
    expect(shell.panelSize('left')).toBeNull();
  });

  it('keeps a size in memory but not in storage when size persistence is off', () => {
    const store = adapter({ sizes: { right: 480 } });
    const shell = createShellState({
      config: { right: { resizable: true, persist: { size: false } } },
      settingsAdapter: store,
    });
    void shell.hydrate();
    expect(shell.panelSize('right')).toBeNull();
    shell.setPanelSize('right', 500);
    expect(shell.panelSize('right')).toBe(500);
    expect(store.writes.at(-1)?.sizes).toBeUndefined();
  });
});

describe('persistence opt-out', () => {
  it('reports what an edge persists', () => {
    const config = resolveShellConfig({
      left: { persist: false },
      right: { persist: { state: false } },
      bottom: { viewportDefaults: { phone: 'collapsed' } },
    });
    expect(panelPersists(config.panels.left, 'state')).toBe(false);
    expect(panelPersists(config.panels.left, 'size')).toBe(false);
    expect(panelPersists(config.panels.right, 'state')).toBe(false);
    expect(panelPersists(config.panels.right, 'size')).toBe(true);
    expect(panelPersists(config.panels.bottom, 'state')).toBe(false);
    expect(panelPersists(config.panels.top, 'state')).toBe(true);
  });

  it('strips unpersisted panels and sizes on write and on read', async () => {
    const config = resolveShellConfig({ left: { persist: false } });
    expect(
      stripUnpersistedSettings(
        {
          panels: { left: 'expanded', right: 'collapsed' },
          sizes: { left: 300 },
        },
        config,
      ),
    ).toEqual({ panels: { right: 'collapsed' } });

    const store = adapter({
      panels: { left: 'expanded' },
      hotkeysEnabled: false,
    });
    const shell = createShellState({
      config: { left: { persist: false, initial: 'collapsed' } },
      settingsAdapter: store,
    });
    await shell.hydrate();
    expect(shell.panels.left).toBe('collapsed');
    expect(shell.settings.hotkeysEnabled).toBe(false);
    shell.expandPanel('left');
    expect(shell.panels.left).toBe('expanded');
    expect(store.writes.at(-1)?.panels).toBeUndefined();
  });
});
