import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AdminShell from '../admin-shell/AdminShell.svelte';
import adminShellSource from '../admin-shell/AdminShell.svelte?raw';
import { createShellState } from '../admin-shell/state.svelte.js';
import type { ShellFocusTool } from '../admin-shell/types.js';

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

function activeToolSnippet() {
  return createRawSnippet<[{ tool: ShellFocusTool | null }]>((context) => ({
    render: () => `<span>${context().tool?.id ?? 'none'} panel</span>`,
  }));
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe('AdminShell', () => {
  it('renders the four edge shell and body content', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        title: 'Ops',
        children: textSnippet('main work'),
      },
    });

    try {
      expect(container.querySelector('.smrt-admin-shell')).not.toBeNull();
      expect(container.querySelector('header')?.textContent).toContain('Ops');
      expect(container.querySelector('main')?.textContent).toContain(
        'main work',
      );
      expect(container.querySelector('[role="navigation"]')).not.toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('pins the shell to the viewport so long workspace content scrolls inside main', () => {
    expect(adminShellSource).toMatch(
      /\.smrt-admin-shell\s*\{[^}]*\bblock-size:\s*100svh\s*;/,
    );
  });

  it('toggles a physical-code panel hotkey', async () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        children: textSnippet('main work'),
      },
    });

    try {
      const shell = container.querySelector('.smrt-admin-shell');
      expect(shell?.getAttribute('data-top-state')).toBe('collapsed');

      await tick();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      flushSync();

      expect(shell?.getAttribute('data-top-state')).toBe('expanded');
    } finally {
      unmount(component);
    }
  });

  it('hides hotkey badges when shell hotkeys are disabled', () => {
    const state = createShellState({
      settings: { hotkeysEnabled: false },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        children: textSnippet('main work'),
      },
    });

    try {
      expect(
        container.querySelector('.smrt-admin-shell__edge-toggle-kbd'),
      ).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('keeps the focus rail visible when the right panel is expanded', () => {
    const state = createShellState({
      config: {
        right: {
          initial: 'expanded',
        },
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        children: textSnippet('main work'),
        focusRail: textSnippet('focus rail'),
        focusPanel: textSnippet('focus panel'),
      },
    });

    try {
      const right = container.querySelector('.smrt-admin-shell__edge--right');
      const rail = right?.querySelector('.smrt-admin-shell__rail');
      const panel = right?.querySelector('.smrt-admin-shell__panel--right');

      expect(right?.getAttribute('data-state')).toBe('expanded');
      expect(rail?.textContent).toContain('focus rail');
      expect(panel?.textContent).toContain('focus panel');
    } finally {
      unmount(component);
    }
  });

  it('renders the active registered focus tool after switching tools', async () => {
    const state = createShellState({
      config: { right: { initial: 'expanded' } },
    });
    state.registerFocusTool({
      id: 'usage',
      label: 'Usage',
    });
    state.registerFocusTool({
      id: 'tasks',
      label: 'Tasks',
    });

    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        children: textSnippet('main work'),
        focusPanel: activeToolSnippet(),
      },
    });

    try {
      const panel = container.querySelector('.smrt-admin-shell__panel--right');
      expect(panel?.textContent).toContain('usage panel');

      state.openFocusTool('tasks');
      await tick();

      expect(panel?.textContent).toContain('tasks panel');
      expect(panel?.textContent).not.toContain('usage panel');
    } finally {
      unmount(component);
    }
  });

  it('pins a tenant footer below the scrolling tenant panel', () => {
    const state = createShellState({
      config: { left: { initial: 'expanded' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        children: textSnippet('main work'),
        tenantPanel: textSnippet('tenant navigation'),
        tenantFooter: textSnippet('account menu'),
      },
    });

    try {
      expect(
        container.querySelector('.smrt-admin-shell__tenant-content')
          ?.textContent,
      ).toContain('tenant navigation');
      expect(
        container.querySelector('.smrt-admin-shell__tenant-footer')
          ?.textContent,
      ).toContain('account menu');
    } finally {
      unmount(component);
    }
  });

  it('publishes collapsed side sizes for stable top and bottom chrome', () => {
    const state = createShellState({
      config: {
        left: {
          collapsedSize: '5rem',
          expandedSize: '20rem',
          initial: 'expanded',
        },
        right: {
          collapsedSize: '6rem',
          expandedSize: '24rem',
          initial: 'expanded',
        },
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        children: textSnippet('main work'),
      },
    });

    try {
      const shell = container.querySelector('.smrt-admin-shell');
      const style = shell?.getAttribute('style');

      expect(style).toContain('--smrt-admin-shell-left-track: 20rem');
      expect(style).toContain('--smrt-admin-shell-right-track: 24rem');
      expect(style).toContain('--smrt-admin-shell-left-collapsed: 5rem');
      expect(style).toContain('--smrt-admin-shell-right-collapsed: 6rem');
    } finally {
      unmount(component);
    }
  });

  it('does not reserve chrome corner space for hidden side edges', () => {
    const state = createShellState({
      config: {
        left: false,
        right: false,
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        children: textSnippet('main work'),
      },
    });

    try {
      const shell = container.querySelector('.smrt-admin-shell');
      const style = shell?.getAttribute('style');

      expect(style).toContain('--smrt-admin-shell-left-track: 0rem');
      expect(style).toContain('--smrt-admin-shell-right-track: 0rem');
      expect(style).toContain('--smrt-admin-shell-left-collapsed: 0rem');
      expect(style).toContain('--smrt-admin-shell-right-collapsed: 0rem');
    } finally {
      unmount(component);
    }
  });

  it('collapses corner tracks when no corner snippets are mounted', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        title: 'Ops',
        children: textSnippet('main work'),
      },
    });

    try {
      const topEdge = container.querySelector(
        '.smrt-admin-shell__edge--top',
      ) as HTMLElement;
      const band = container.querySelector(
        '.smrt-admin-shell__band--top',
      ) as HTMLElement;
      expect(topEdge.style.getPropertyValue('--edge-columns').trim()).toBe(
        'minmax(0, 1fr)',
      );
      expect(band.style.getPropertyValue('--band-column').trim()).toBe('1');
    } finally {
      unmount(component);
    }
  });

  it('reserves corner tracks only for mounted corner snippets', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        title: 'Ops',
        topLeftCorner: textSnippet('corner'),
        children: textSnippet('main work'),
      },
    });

    try {
      const topEdge = container.querySelector(
        '.smrt-admin-shell__edge--top',
      ) as HTMLElement;
      const band = container.querySelector(
        '.smrt-admin-shell__band--top',
      ) as HTMLElement;
      const columns = topEdge.style.getPropertyValue('--edge-columns');
      expect(columns).toContain('--smrt-admin-shell-left-collapsed');
      expect(columns).not.toContain('--smrt-admin-shell-right-collapsed');
      expect(band.style.getPropertyValue('--band-column').trim()).toBe('2');
    } finally {
      unmount(component);
    }
  });
});
