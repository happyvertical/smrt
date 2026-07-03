import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AdminShell from '../admin-shell/AdminShell.svelte';

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
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
});
