/**
 * Tests for the <ToolsDock> renderer.
 *
 * Verifies that rail buttons are rendered for available tools, that clicking
 * one opens the panel and activates the tool, that the close button closes
 * the panel, and that the empty state renders when fetchAvailability filters
 * everything away.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import RenderHarness from './render-harness.svelte';

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

  it('opens the panel and marks the active button with aria-current when clicked', () => {
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
    expect(chatBtn.getAttribute('aria-current')).toBe('true');
    expect(chatBtn.getAttribute('aria-pressed')).toBe('true');

    // Panel header reflects the active tool.
    const heading = target.querySelector('.tools-dock__panel-header h3');
    expect(heading?.textContent).toBe('Chat');
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
