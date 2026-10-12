import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './app-shell-phone-tabs-harness.svelte';

let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let phone = true;

beforeEach(() => {
  phone = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      if (query.includes('prefers-reduced-motion')) return false;
      return /max-width:\s*48rem/.test(query) ? phone : false;
    },
    media: query,
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
const bar = () =>
  container.querySelector<HTMLElement>('[data-testid="phone-bottom-bar"]');
const tabs = () =>
  [...(bar()?.querySelectorAll<HTMLElement>('[data-item]') ?? [])].map(
    (el) => el.dataset.item,
  );

describe('AppShell phone tab bar', () => {
  it('renders nothing by default (backward compatible)', async () => {
    await render({ phoneTabBar: false });
    expect(bar()).toBeNull();
    expect(
      container.querySelector('[data-testid="admin-shell-phone-bar"]'),
    ).toBeNull();
  });

  it('shows nav tabs, the dock tab and More on a phone', async () => {
    await render();
    expect(tabs()).toEqual(['/n1', '/n2', '/n3', 'dock:assistant', 'more']);
  });

  it('marks the current page with aria-current', async () => {
    await render({ currentHref: '/n2/detail' });
    const current = bar()!.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect((current[0] as HTMLElement).dataset.item).toBe('/n2');
  });

  it('omits More when navigation fits, and honours { items }', async () => {
    await render({ count: 3 });
    expect(tabs()).toEqual(['/n1', '/n2', '/n3', 'dock:assistant']);
    unmount(component!);
    component = undefined;
    container.innerHTML = '';
    await render({ count: 6, toggles: [], phoneTabBar: { items: 2 } });
    expect(tabs()).toEqual(['/n1', 'tools', 'more']);
  });

  it('draws icons for tabs, a placeholder when none is set', async () => {
    await render();
    const icons = bar()!.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThanOrEqual(5);
  });

  it('moves the dock toggle from the header to the tab bar on phones and drops the Tools opener', async () => {
    await render();
    expect(
      container.querySelector('[data-testid="dock-toggles"] [data-dock-tool]'),
    ).toBeNull();
    expect(
      container.querySelector('.smrt-admin-shell__tools-opener'),
    ).toBeNull();
  });

  it('dock tab opens the right edge as a sheet; More closes it by opening the drawer', async () => {
    await render();
    const edge = () =>
      container.querySelector<HTMLElement>('.smrt-admin-shell__edge--right')!;
    expect(edge().dataset.phone).toBe('sheet');
    container
      .querySelector<HTMLElement>('[data-item="dock:assistant"]')!
      .click();
    await settle();
    expect(edge().dataset.state).toBe('expanded');
    container.querySelector<HTMLElement>('[data-item="more"]')!.click();
    await settle();
    expect(edge().dataset.state).not.toBe('expanded');
    expect(
      container.querySelector<HTMLElement>('.smrt-admin-shell__edge--left')!
        .dataset.state,
    ).toBe('expanded');
  });

  it('phoneDock="drawer" keeps the drawer and an explicit value beats config', async () => {
    await render({
      phoneDock: 'drawer',
      config: { right: { phone: 'sheet' } },
    });
    expect(
      container.querySelector<HTMLElement>('.smrt-admin-shell__edge--right')!
        .dataset.phone,
    ).toBe('drawer');
  });

  it('is not rendered above the phone breakpoint', async () => {
    phone = false;
    await render();
    expect(bar()).toBeNull();
    expect(
      container.querySelector('[data-testid="dock-toggles"] [data-dock-tool]'),
    ).not.toBeNull();
  });
});
