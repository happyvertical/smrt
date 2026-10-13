import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './app-shell-dock-fallback-harness.svelte';
import PhoneHarness from './app-shell-phone-tabs-harness.svelte';

let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let phone = false;

beforeEach(() => {
  phone = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /max-width:\s*48rem/.test(query) ? phone : false,
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
  component = mount(Harness, { target: container, props });
  await settle();
}

function remount() {
  if (component) unmount(component);
  component = undefined;
  container.replaceChildren();
}

const tool = () =>
  container.querySelector<HTMLElement>('[data-dock-tool="assistant"]')!;

/** Dispatch a cancelable click and report whether navigation was cancelled. */
function clickCancelled(el: HTMLElement): boolean {
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  // jsdom does not navigate; observe the default after the handlers ran.
  el.dispatchEvent(click);
  return click.defaultPrevented;
}

describe('DockToggle fallback', () => {
  it('registered and ready: toggles the dock, ignoring href', async () => {
    await render({ href: '/ai/' });
    expect(tool().tagName).toBe('BUTTON');
    expect(tool().getAttribute('aria-label')).toBe('Assistant');
    const before = tool().getAttribute('aria-pressed');
    tool().click();
    await settle();
    expect(tool().getAttribute('aria-pressed')).not.toBe(before);
  });

  it('registered but not ready: a link named "Set up Assistant", no pressed state', async () => {
    await render({ href: '/ai/', ready: false });
    expect(tool().tagName).toBe('A');
    expect(tool().getAttribute('href')).toBe('/ai/');
    expect(tool().getAttribute('aria-label')).toBe('Set up Assistant');
    expect(tool().getAttribute('title')).toBe('Set up Assistant');
    expect(tool().hasAttribute('aria-pressed')).toBe(false);
    expect(tool().hasAttribute('aria-expanded')).toBe(false);
  });

  it('unregistered with href renders a link; labelNotReady wins over the default', async () => {
    await render({
      registered: false,
      href: '/ai/',
      labelNotReady: 'Open AI setup',
    });
    expect(tool().tagName).toBe('A');
    expect(tool().getAttribute('aria-label')).toBe('Open AI setup');
  });

  it('unregistered without href stays inert', async () => {
    await render({ registered: false });
    expect(tool().tagName).toBe('BUTTON');
    expect(tool().getAttribute('aria-disabled')).toBe('true');
    const before = tool().getAttribute('aria-pressed');
    tool().click();
    await settle();
    expect(tool().getAttribute('aria-pressed')).toBe(before);
  });

  it('unregistered without href: onpress still runs, with the state', async () => {
    const onpress = vi.fn();
    await render({ registered: false, onpress });
    tool().click();
    expect(onpress).toHaveBeenCalledOnce();
    expect(onpress.mock.calls[0][1]).toEqual({
      registered: false,
      ready: true,
    });
  });

  it('onpress returning false suppresses the dock toggle', async () => {
    const onpress = vi.fn(() => false as const);
    await render({ onpress });
    const before = tool().getAttribute('aria-pressed');
    tool().click();
    await settle();
    expect(onpress).toHaveBeenCalledOnce();
    expect(onpress.mock.calls[0][1]).toEqual({ registered: true, ready: true });
    expect(tool().getAttribute('aria-pressed')).toBe(before);
  });

  it('onpress returning false cancels link navigation', async () => {
    const onpress = vi.fn(() => false as const);
    await render({ ready: false, href: '/ai/', onpress });
    expect(clickCancelled(tool())).toBe(true);
    expect(onpress.mock.calls[0][1]).toEqual({
      registered: true,
      ready: false,
    });
  });

  it('onpress calling preventDefault also stops the press', async () => {
    const onpress = vi.fn((event: MouseEvent) => event.preventDefault());
    await render({ onpress });
    const before = tool().getAttribute('aria-pressed');
    tool().click();
    await settle();
    expect(tool().getAttribute('aria-pressed')).toBe(before);
  });

  it('without a veto the link is followed (not cancelled)', async () => {
    const onpress = vi.fn();
    await render({ ready: false, href: '/ai/', onpress });
    expect(clickCancelled(tool())).toBe(false);
    expect(onpress).toHaveBeenCalledOnce();
  });

  it('reacts when ready flips after mount', async () => {
    await render({ href: '/ai/' });
    const live = component as unknown as { setReady(value: boolean): void };
    expect(tool().tagName).toBe('BUTTON');
    live.setReady(false);
    await settle();
    expect(tool().tagName).toBe('A');
    expect(tool().getAttribute('aria-label')).toBe('Set up Assistant');
    live.setReady(true);
    await settle();
    expect(tool().tagName).toBe('BUTTON');
    expect(tool().getAttribute('aria-label')).toBe('Assistant');
  });
});

describe('DockToggle fallback in the phone tab bar', () => {
  const tab = () =>
    container.querySelector<HTMLElement>('[data-item="dock:assistant"]')!;

  async function renderPhone(toggle: Record<string, unknown>, withTool = true) {
    remount();
    phone = true;
    component = mount(PhoneHarness, {
      target: container,
      props: {
        count: 2,
        withTool,
        toggles: [{ tool: 'assistant', label: 'Assistant', ...toggle }],
      },
    });
    await settle();
  }

  it('ready and registered: a toggle button as before', async () => {
    await renderPhone({ href: '/ai/' });
    expect(tab().tagName).toBe('BUTTON');
    expect(tab().getAttribute('aria-label')).toBe('Assistant');
    const before = tab().getAttribute('aria-expanded');
    tab().click();
    await settle();
    expect(tab().getAttribute('aria-expanded')).not.toBe(before);
  });

  it('not ready: a "Set up" link tab', async () => {
    await renderPhone({ href: '/ai/', ready: false });
    expect(tab().tagName).toBe('A');
    expect(tab().getAttribute('href')).toBe('/ai/');
    expect(tab().getAttribute('aria-label')).toContain('Set up Assistant');
  });

  it('unregistered with href: a link tab', async () => {
    await renderPhone({ href: '/ai/' }, false);
    expect(tab().tagName).toBe('A');
  });

  it('onpress can veto the tab press', async () => {
    const onpress = vi.fn(() => false as const);
    await renderPhone({ onpress });
    const before = tab().getAttribute('aria-expanded');
    tab().click();
    await settle();
    expect(onpress).toHaveBeenCalledOnce();
    expect(tab().getAttribute('aria-expanded')).toBe(before);
  });
});
