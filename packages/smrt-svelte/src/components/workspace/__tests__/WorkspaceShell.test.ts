/**
 * Tests for WorkspaceShell — issue happyvertical/smrt#1227.
 *
 * Uses Svelte 5's `mount` / `unmount` APIs and `createRawSnippet` to exercise
 * the component in jsdom without pulling in `@testing-library/svelte` (which
 * the package doesn't depend on).
 */

import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WorkspaceShell from '../WorkspaceShell.svelte';

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

describe('WorkspaceShell', () => {
  it('renders with only required children prop', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('main content'),
      },
    });

    try {
      expect(container.querySelector('.smrt-workspace-shell')).not.toBeNull();
      expect(
        container.querySelector('.smrt-workspace-content')?.textContent,
      ).toContain('main content');
    } finally {
      unmount(component);
    }
  });

  it('renders the brand snippet when provided', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        brand: textSnippet('MyBrand'),
      },
    });

    try {
      const brand = container.querySelector('.brand');
      expect(brand?.textContent).toContain('MyBrand');
    } finally {
      unmount(component);
    }
  });

  it('falls back to title / subtitle / eyebrow when no brand snippet is given', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        title: 'Workspace',
        subtitle: 'Engineering',
        eyebrow: 'SMRT',
      },
    });

    try {
      const brand = container.querySelector('.brand');
      expect(brand?.textContent).toContain('Workspace');
      expect(brand?.textContent).toContain('Engineering');
      expect(brand?.textContent).toContain('SMRT');
    } finally {
      unmount(component);
    }
  });

  it('renders the nav snippet inside an aria-labelled region', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        nav: textSnippet('nav-content'),
      },
    });

    try {
      const navRegion = container.querySelector('nav.nav-region');
      expect(navRegion).not.toBeNull();
      expect(navRegion?.getAttribute('aria-label')).toBe(
        'Workspace navigation',
      );
      expect(navRegion?.textContent).toContain('nav-content');
    } finally {
      unmount(component);
    }
  });

  it('renders the sidebar footer snippet when provided', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        sidebarFooter: textSnippet('account-menu'),
      },
    });

    try {
      const footer = container.querySelector('.sidebar-footer');
      expect(footer?.textContent).toContain('account-menu');
    } finally {
      unmount(component);
    }
  });

  it('renders topbar actions on the right of the top bar', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        topbarActions: textSnippet('action-button'),
      },
    });

    try {
      const actions = container.querySelector('.topbar-actions');
      expect(actions?.textContent).toContain('action-button');
    } finally {
      unmount(component);
    }
  });

  it('does NOT render inspector when showInspector is false', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: false,
      },
    });

    try {
      expect(container.querySelector('.smrt-workspace-inspector')).toBeNull();
      const shell = container.querySelector('.smrt-workspace-shell');
      expect(shell?.classList.contains('has-inspector')).toBe(false);
    } finally {
      unmount(component);
    }
  });

  it('renders inspector and has-inspector class when showInspector is true', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
      },
    });

    try {
      const inspector = container.querySelector('.smrt-workspace-inspector');
      expect(inspector).not.toBeNull();
      expect(inspector?.textContent).toContain('inspector-content');
      const shell = container.querySelector('.smrt-workspace-shell');
      expect(shell?.classList.contains('has-inspector')).toBe(true);
    } finally {
      unmount(component);
    }
  });

  it('renders inspector close button when onCloseInspector is provided', () => {
    let closed = false;
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
        onCloseInspector: () => {
          closed = true;
        },
      },
    });

    try {
      const closeBtn =
        container.querySelector<HTMLButtonElement>('.inspector-close');
      expect(closeBtn).not.toBeNull();
      closeBtn?.click();
      expect(closed).toBe(true);
    } finally {
      unmount(component);
    }
  });

  it('omits the inspector close button when onCloseInspector is not provided', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
      },
    });

    try {
      expect(container.querySelector('.inspector-close')).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('renders the inspector rail snippet when provided', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspectorRail: textSnippet('rail-button'),
      },
    });

    try {
      const rail = container.querySelector('.smrt-workspace-inspector-rail');
      expect(rail).not.toBeNull();
      expect(rail?.textContent).toContain('rail-button');
    } finally {
      unmount(component);
    }
  });

  it('shows a collapse toggle by default and invokes onToggleCollapsed', () => {
    let toggles = 0;
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        title: 'Brand',
        collapsed: false,
        onToggleCollapsed: () => {
          toggles += 1;
        },
      },
    });

    try {
      const toggle =
        container.querySelector<HTMLButtonElement>('.shell-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      toggle?.click();
      expect(toggles).toBe(1);
    } finally {
      unmount(component);
    }
  });

  it('hides the collapse toggle when collapsible is false', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        title: 'Brand',
        collapsible: false,
      },
    });

    try {
      expect(container.querySelector('.shell-toggle')).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('applies sidebar-collapsed class when collapsed prop is true', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        collapsed: true,
      },
    });

    try {
      const shell = container.querySelector('.smrt-workspace-shell');
      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);
    } finally {
      unmount(component);
    }
  });

  it('renders the mode badge when modeLabel is provided', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        modeLabel: 'Local-first mode',
        modeStatus: 'local-only',
      },
    });

    try {
      const badge = container.querySelector('.mode-badge');
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute('data-status')).toBe('local-only');
      expect(badge?.textContent).toContain('Local-first mode');
    } finally {
      unmount(component);
    }
  });

  it('omits the mode badge when no modeLabel/modeStatus is provided', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
      },
    });

    try {
      expect(container.querySelector('.mode-badge')).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('invokes onCloseInspector when Escape is pressed while inspector is open', async () => {
    let closes = 0;
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
        onCloseInspector: () => {
          closes += 1;
        },
      },
    });

    try {
      await tick();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(closes).toBe(1);
    } finally {
      unmount(component);
    }
  });
});
