import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellDock } from '../../workspace/admin-shell/dock.js';
import Harness from './app-shell-dock-toggles-harness.svelte';

let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let dock: ShellDock;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  container.remove();
});

async function settle() {
  for (let i = 0; i < 4; i++) await tick();
}

async function render(props: Record<string, unknown> = {}) {
  component = mount(Harness, {
    target: container,
    props: { onDock: (d: ShellDock) => (dock = d), ...props },
  });
  await settle();
}

const toggle = () =>
  container.querySelector<HTMLButtonElement>('[data-dock-tool="assistant"]')!;
const panel = () =>
  container.querySelector<HTMLElement>('.smrt-admin-shell__panel--right');

describe('AppShell dock toggles', () => {
  it('renders no header toggles without the prop', async () => {
    await render({ toggles: [] });
    expect(container.querySelector('[data-testid="dock-toggles"]')).toBeNull();
  });

  it('renders the toggle in the header with a tooltip and chat icon', async () => {
    await render();
    const header = container.querySelector('#smrt-admin-shell-header')!;
    expect(header.contains(toggle())).toBe(true);
    expect(toggle().getAttribute('aria-label')).toBe('Assistant');
    expect(toggle().getAttribute('title')).toBe('Assistant');
    expect(toggle().querySelector('svg')).not.toBeNull();
    expect(toggle().getAttribute('aria-controls')).toBe(
      'smrt-admin-shell-right-panel',
    );
    expect(
      container.querySelector('#smrt-admin-shell-right-panel'),
    ).not.toBeNull();
  });

  it('toggles the dock open and closed and mirrors state in aria', async () => {
    await render();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(dock.active).toBeNull();

    toggle().click();
    await settle();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(dock.active).toBe('assistant');
    expect(panel()?.hidden).toBe(false);

    toggle().click();
    await settle();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(dock.active).toBeNull();
  });

  it('moves focus into the dock on open and back to the toggle on Escape', async () => {
    await render();
    toggle().focus();
    toggle().click();
    await settle();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="assistant-input"]'),
    );

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    expect(dock.active).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });

  it('returns focus to the toggle when closed by the toggle or by code', async () => {
    await render();
    toggle().focus();
    toggle().click();
    await settle();
    dock.close();
    await settle();
    expect(document.activeElement).toBe(toggle());
  });

  it('exposes open, close and toggle for code, returning to the opener', async () => {
    await render();
    const outside = container.querySelector<HTMLElement>(
      '[data-testid="outside"]',
    )!;
    outside.focus();
    expect(dock.open('assistant')).toBe(true);
    await settle();
    expect(dock.isOpen('assistant')).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(dock.tools).toEqual(['assistant']);

    dock.toggle('assistant');
    await settle();
    expect(dock.active).toBeNull();
    expect(document.activeElement).toBe(outside);

    dock.open('assistant', { focus: false });
    await settle();
    expect(dock.active).toBe('assistant');
    expect(document.activeElement).toBe(outside);
    dock.close();
  });

  it('ignores unknown tools', async () => {
    await render({
      toggles: [{ tool: 'missing', label: 'Missing', icon: 'M' }],
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-dock-tool="missing"]',
    )!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toContain('M');
    expect(dock.open('missing')).toBe(false);
    button.click();
    await settle();
    expect(dock.active).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});
