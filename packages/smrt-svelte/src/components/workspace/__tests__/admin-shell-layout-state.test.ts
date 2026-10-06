import { describe, expect, it } from 'vitest';
import { createShellState } from '../admin-shell/state.svelte.js';

const config = {
  left: { initial: 'expanded' as const },
  right: false as const,
};

describe('ShellState layout panels', () => {
  it('starts an edge hidden and keeps toggles and hotkeys from reopening it', () => {
    const shell = createShellState({
      config,
      layoutPanels: { left: { visible: false } },
    });
    expect(shell.panels.left).toBe('hidden');
    expect(shell.isEdgeShown('left')).toBe(false);
    shell.setPanel('left', 'expanded');
    shell.togglePanel('left');
    shell.expandPanel('left');
    expect(shell.panels.left).toBe('hidden');
  });

  it('hides live and restores the configured state when shown again', () => {
    const shell = createShellState({ config });
    expect(shell.panels.left).toBe('expanded');
    shell.setLayoutPanels({ left: { visible: false } });
    expect(shell.panels.left).toBe('hidden');
    shell.setLayoutPanels({});
    expect(shell.panels.left).toBe('expanded');
  });

  it('never discards a stored toggle when a layout is loaded', () => {
    const shell = createShellState({ config });
    shell.setPanel('left', 'collapsed');
    shell.setLayoutPanels({ left: { initial: 'expanded' } });
    expect(shell.panels.left).toBe('collapsed');
    expect(shell.settings.panels?.left).toBe('collapsed');
  });

  it('applies an edited starting state at once, replacing a stored toggle', () => {
    const shell = createShellState({ config });
    shell.setPanel('left', 'collapsed');
    shell.setPanelStart('left', 'expanded');
    expect(shell.panels.left).toBe('expanded');
    expect(shell.settings.panels?.left).toBeUndefined();
    shell.setLayoutPanels({ left: { visible: false } });
    shell.setPanelStart('left', 'collapsed');
    expect(shell.panels.left).toBe('hidden');
  });

  it('persists the peer collapse when a start state closes an exclusive peer', () => {
    const writes: unknown[] = [];
    const shell = createShellState({
      config: {
        left: { initial: 'collapsed', exclusiveGroup: 'g' },
        right: { initial: 'expanded', exclusiveGroup: 'g' },
      },
      settingsAdapter: {
        read: () => null,
        write: (delta) => {
          writes.push(structuredClone(delta));
        },
      },
    });
    shell.setPanelStart('left', 'expanded');
    expect(shell.panels.right).toBe('collapsed');
    expect(writes.at(-1)).toMatchObject({ panels: { right: 'collapsed' } });
  });

  it('refuses to open the dock while the user hides the right edge', () => {
    const shell = createShellState({ config: {} });
    shell.registerFocusTool({ id: 'assistant', label: 'Assistant' });
    expect(shell.dockAvailable).toBe(true);
    shell.setLayoutPanels({ right: { visible: false } });
    expect(shell.dockAvailable).toBe(false);
    expect(shell.openDockTool('assistant')).toBe(false);
    expect(shell.toggleDockTool('assistant')).toBe(false);
    expect(shell.panels.right).toBe('hidden');
    shell.setLayoutPanels({});
    expect(shell.openDockTool('assistant')).toBe(true);
    expect(shell.panels.right).toBe('expanded');
  });

  it('uses the layout starting state below a stored toggle on later loads', () => {
    const shell = createShellState({
      config: { left: { initial: 'collapsed' } },
      layoutPanels: { left: { initial: 'expanded' } },
    });
    expect(shell.panels.left).toBe('expanded');
    shell.applySettings({ panels: { left: 'collapsed' } }, { persist: false });
    expect(shell.panels.left).toBe('collapsed');
  });

  it('leaves host-hidden edges alone and survives a viewport change', () => {
    const shell = createShellState({
      config: {
        ...config,
        top: { viewportDefaults: { phone: 'expanded', desktop: 'collapsed' } },
      },
      viewport: 'desktop',
    });
    shell.setLayoutPanels({
      right: { visible: true, initial: 'expanded' },
      top: { visible: false },
    });
    expect(shell.panels.right).toBe('hidden');
    expect(shell.panels.top).toBe('hidden');
    shell.setViewport('phone');
    expect(shell.panels.top).toBe('hidden');
  });

  it('stores and clears the layout in the settings delta', () => {
    const shell = createShellState({ config });
    shell.setLayout({ version: 1, hidden: ['/a'] });
    expect(shell.settings.layout).toEqual({ version: 1, hidden: ['/a'] });
    shell.setLayout({ version: 1 });
    expect(shell.settings.layout).toBeUndefined();
  });
});
