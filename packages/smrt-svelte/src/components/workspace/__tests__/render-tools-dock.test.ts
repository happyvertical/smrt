/**
 * Tests for the <ToolsDock> renderer.
 *
 * Verifies that rail buttons are rendered for available tools, that clicking
 * one opens the panel and activates the tool, that the close button closes
 * the panel, and that the empty state renders when fetchAvailability filters
 * everything away.
 */

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolsDockInstance } from '../tools-dock/define-tools-dock.svelte.js';
import ContextForwardingHarness from './context-forwarding-harness.svelte';
import RenderHarness from './render-harness.svelte';
import TestIcon from './test-icon.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function render(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(RenderHarness, { target, props });
  mountedComponents.push(component);
  flushSync();
  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const c = mountedComponents.pop();
    if (c) unmount(c);
  }
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe('<ToolsDock> rail layout', () => {
  it('renders a rail button for every available tool', () => {
    const target = render({
      tools: [
        { id: 'chat', label: 'Chat' },
        { id: 'jobs', label: 'Jobs' },
      ],
    });

    const buttons = target.querySelectorAll('.tools-dock__rail-button');
    expect(buttons.length).toBe(2);
    expect(buttons[0].getAttribute('aria-label')).toBe('Chat tool');
    expect(buttons[1].getAttribute('aria-label')).toBe('Jobs tool');
  });

  it('opens the panel and marks the active button with aria-pressed when clicked', () => {
    const target = render({
      tools: [
        { id: 'chat', label: 'Chat' },
        { id: 'jobs', label: 'Jobs' },
      ],
    });

    const chatBtn = target.querySelectorAll<HTMLButtonElement>(
      '.tools-dock__rail-button',
    )[0];
    chatBtn.click();
    flushSync();

    expect(chatBtn.classList.contains('active')).toBe(true);
    // aria-pressed is the right semantics for a toggle button. aria-current
    // is reserved for navigation sets (breadcrumbs, paginators, etc.) — using
    // both on the same control conflicts and should not appear here.
    expect(chatBtn.getAttribute('aria-pressed')).toBe('true');
    expect(chatBtn.getAttribute('aria-current')).toBeNull();

    // Panel header reflects the active tool.
    const heading = target.querySelector('.tools-dock__panel-header h3');
    expect(heading?.textContent).toBe('Chat');
  });

  it('panel exposes role="dialog" and is inert when closed', () => {
    const target = render({
      tools: [{ id: 'chat', label: 'Chat' }],
    });

    const panel = target.querySelector('.tools-dock__panel') as
      | (HTMLElement & { inert: boolean })
      | null;
    expect(panel?.getAttribute('role')).toBe('dialog');
    // Closed state: inert is set so tab order skips the off-screen panel.
    // Svelte 5 sets `inert` via the IDL property; jsdom reflects the property
    // rather than the HTML attribute, so check both.
    expect(panel?.inert === true || panel?.hasAttribute('inert')).toBe(true);

    const chatBtn = target.querySelector<HTMLButtonElement>(
      '.tools-dock__rail-button',
    );
    chatBtn?.click();
    flushSync();

    // Open: inert is cleared so descendants are focusable.
    expect(panel?.inert === false && !panel?.hasAttribute('inert')).toBe(true);
  });

  it('closes when the close button is clicked', () => {
    const target = render({
      tools: [{ id: 'chat', label: 'Chat' }],
      initialOpen: true,
      activateOnMount: 'chat',
    });

    const aside = target.querySelector('.tools-dock--rail');
    expect(aside?.classList.contains('tools-dock--open')).toBe(true);

    const closeBtn =
      target.querySelector<HTMLButtonElement>('.tools-dock__close');
    closeBtn?.click();
    flushSync();

    expect(aside?.classList.contains('tools-dock--open')).toBe(false);
  });

  it('forwards a late-populated `context` prop into the dock', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    let dock: ToolsDockInstance | null = null;
    let setContextProp:
      | ((next: { type: string; title: string } | null | undefined) => void)
      | null = null;

    const component = mount(ContextForwardingHarness, {
      target,
      props: {
        onReady: (api: {
          dock: ToolsDockInstance;
          setContextProp: (
            next: { type: string; title: string } | null | undefined,
          ) => void;
        }) => {
          dock = api.dock;
          setContextProp = api.setContextProp;
        },
      },
    });
    mountedComponents.push(component);
    flushSync();

    // Initial value is undefined — nothing forwarded yet.
    expect(dock?.context).toBeNull();

    // Populate the prop after mount (simulating async route data arrival).
    setContextProp?.({ type: 'route', title: 'Hello' });
    flushSync();
    await tick();

    expect(dock?.context).toEqual({ type: 'route', title: 'Hello' });

    // Change the prop again — the effect should run idempotently.
    setContextProp?.({ type: 'route', title: 'World' });
    flushSync();
    await tick();
    expect(dock?.context).toEqual({ type: 'route', title: 'World' });
  });

  describe('rail glyph rendering', () => {
    it('renders ToolDef.iconComponent inside the rail glyph when provided', () => {
      const target = render({
        tools: [{ id: 'chat', label: 'Chat', iconComponent: TestIcon }],
      });

      const glyph = target.querySelector('.tools-dock__rail-glyph');
      expect(glyph).not.toBeNull();
      // iconComponent rendered → SVG present, first-letter fallback absent.
      const svg = glyph?.querySelector('svg[data-testid="custom-icon"]');
      expect(svg).not.toBeNull();
      // No stray "C" letter text node — only the icon component.
      expect(glyph?.textContent?.trim()).toBe('');
    });

    it('renders ToolDef.icon string when no iconComponent is provided', () => {
      const target = render({
        tools: [{ id: 'chat', label: 'Chat', icon: 'X' }],
      });

      const glyph = target.querySelector('.tools-dock__rail-glyph');
      expect(glyph?.textContent?.trim()).toBe('X');
      // No iconComponent rendered.
      expect(glyph?.querySelector('svg')).toBeNull();
    });

    it('falls back to label.charAt(0).toUpperCase() when neither iconComponent nor icon is set', () => {
      const target = render({
        tools: [{ id: 'chat', label: 'chat' }],
      });

      const glyph = target.querySelector('.tools-dock__rail-glyph');
      // First letter, uppercased — existing behaviour preserved.
      expect(glyph?.textContent?.trim()).toBe('C');
    });

    it('iconComponent takes precedence over icon string when both are provided', () => {
      const target = render({
        tools: [
          { id: 'chat', label: 'Chat', icon: 'X', iconComponent: TestIcon },
        ],
      });

      const glyph = target.querySelector('.tools-dock__rail-glyph');
      // iconComponent wins; the icon string is not rendered.
      expect(
        glyph?.querySelector('svg[data-testid="custom-icon"]'),
      ).not.toBeNull();
      expect(glyph?.textContent?.trim()).toBe('');
    });
  });

  describe('topbar button icon rendering', () => {
    it('renders ToolDef.iconComponent before the label in topbar layout', () => {
      const target = render({
        layout: 'topbar',
        tools: [{ id: 'chat', label: 'Chat', iconComponent: TestIcon }],
      });

      const btn = target.querySelector<HTMLButtonElement>(
        '.tools-dock__topbar-button',
      );
      expect(btn).not.toBeNull();
      const icon = btn?.querySelector('.tools-dock__topbar-button-icon');
      const label = btn?.querySelector('.tools-dock__topbar-button-label');
      expect(icon).not.toBeNull();
      expect(label?.textContent).toBe('Chat');
      // Icon hosts the test SVG.
      expect(
        icon?.querySelector('svg[data-testid="custom-icon"]'),
      ).not.toBeNull();
      // Icon precedes the label in document order so screen-magnifier /
      // visual layout matches reading order.
      if (icon && label) {
        expect(
          icon.compareDocumentPosition(label) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });

    it('renders ToolDef.icon string before the label in topbar layout', () => {
      const target = render({
        layout: 'topbar',
        tools: [{ id: 'chat', label: 'Chat', icon: 'X' }],
      });

      const btn = target.querySelector<HTMLButtonElement>(
        '.tools-dock__topbar-button',
      );
      const icon = btn?.querySelector('.tools-dock__topbar-button-icon');
      expect(icon?.textContent?.trim()).toBe('X');
      // No SVG when only the string icon was supplied.
      expect(icon?.querySelector('svg')).toBeNull();
    });

    it('omits the icon span entirely when neither iconComponent nor icon is set', () => {
      const target = render({
        layout: 'topbar',
        tools: [{ id: 'chat', label: 'Chat' }],
      });

      const btn = target.querySelector<HTMLButtonElement>(
        '.tools-dock__topbar-button',
      );
      const icon = btn?.querySelector('.tools-dock__topbar-button-icon');
      const label = btn?.querySelector('.tools-dock__topbar-button-label');
      // Topbar buttons stay label-only when no icon is provided — unlike
      // the rail, where we fall back to the first letter of the label.
      expect(icon).toBeNull();
      expect(label?.textContent).toBe('Chat');
    });

    it('iconComponent takes precedence over icon string in topbar layout', () => {
      const target = render({
        layout: 'topbar',
        tools: [
          { id: 'chat', label: 'Chat', icon: 'X', iconComponent: TestIcon },
        ],
      });

      const btn = target.querySelector<HTMLButtonElement>(
        '.tools-dock__topbar-button',
      );
      const icon = btn?.querySelector('.tools-dock__topbar-button-icon');
      // SVG wins, the string "X" must not appear.
      expect(
        icon?.querySelector('svg[data-testid="custom-icon"]'),
      ).not.toBeNull();
      expect(icon?.textContent?.trim()).toBe('');
    });
  });

  it('renders an empty state when no tools are available', async () => {
    const target = render({
      tools: [{ id: 'chat', label: 'Chat' }],
      // fetchAvailability that returns nothing means no tools surface.
      fetchAvailability: async () => [],
      activateOnMount: null,
      setContextOnMount: { type: 'route' },
      forceOpen: true,
    });

    // Wait for the microtask resolving fetchAvailability.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    const buttons = target.querySelectorAll('.tools-dock__rail-button');
    expect(buttons.length).toBe(0);
    // When forced open, the panel body renders the empty state.
    const empty = target.querySelector('.tools-dock__empty');
    expect(empty?.textContent).toContain('No tools');
  });
});
