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

  it('renders an interactive button backdrop only when onCloseInspector is set', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
        onCloseInspector: () => {},
      },
    });

    try {
      const backdrop = container.querySelector('.inspector-backdrop');
      expect(backdrop).not.toBeNull();
      expect(backdrop?.tagName).toBe('BUTTON');
    } finally {
      unmount(component);
    }
  });

  it('renders a non-interactive backdrop when onCloseInspector is omitted', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
      },
    });

    try {
      const backdrop = container.querySelector('.inspector-backdrop');
      expect(backdrop).not.toBeNull();
      expect(backdrop?.tagName).toBe('DIV');
      expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      unmount(component);
    }
  });

  it('renders the default "Inspector" header label when inspectorTitle is omitted', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
      },
    });

    try {
      const title = container.querySelector('.inspector-title');
      expect(title?.textContent).toBe('Inspector');
    } finally {
      unmount(component);
    }
  });

  it('uses a custom inspectorTitle and wires it via aria-labelledby', () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        inspector: textSnippet('inspector-content'),
        showInspector: true,
        inspectorTitle: 'Properties',
      },
    });

    try {
      const title = container.querySelector('.inspector-title');
      expect(title?.textContent).toBe('Properties');
      const aside = container.querySelector('.smrt-workspace-inspector');
      const labelledBy = aside?.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      // The id pointed at by aria-labelledby must resolve to the title node.
      const referenced = labelledBy
        ? container.querySelector(`#${labelledBy}`)
        : null;
      expect(referenced).toBe(title);
    } finally {
      unmount(component);
    }
  });

  it('marks the sidebar inert on mobile when the drawer is closed', async () => {
    const originalMatchMedia = window.matchMedia;
    // Force the mobile breakpoint so `isMobileViewport` becomes true.
    window.matchMedia = ((query: string) => ({
      matches: /max-width:\s*960px/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        nav: textSnippet('nav-content'),
      },
    });

    try {
      await tick();
      const sidebar = container.querySelector('.smrt-workspace-sidebar');
      // jsdom reflects the `inert` attribute as a boolean property — both
      // forms are acceptable, the contract is "keyboard tab order skips
      // the sidebar when it's offscreen".
      expect(
        sidebar?.hasAttribute('inert') ||
          (sidebar as HTMLElement | null)?.inert === true,
      ).toBe(true);
    } finally {
      unmount(component);
      window.matchMedia = originalMatchMedia;
    }
  });

  it('restores focus to the hamburger button when the mobile drawer closes via Escape', async () => {
    const component = mount(WorkspaceShell, {
      target: container,
      props: {
        children: textSnippet('content'),
        nav: textSnippet('nav-content'),
      },
    });

    try {
      const hamburger =
        container.querySelector<HTMLButtonElement>('.mobile-menu');
      expect(hamburger).not.toBeNull();
      // Simulate keyboard-driven opening of the drawer.
      hamburger?.focus();
      expect(document.activeElement).toBe(hamburger);
      hamburger?.click();
      await tick();
      // Move focus elsewhere as a real drawer interaction would.
      const elsewhere = document.createElement('button');
      container.appendChild(elsewhere);
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await tick();
      expect(document.activeElement).toBe(hamburger);
    } finally {
      unmount(component);
    }
  });
});
