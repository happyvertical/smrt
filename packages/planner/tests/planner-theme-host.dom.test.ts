/**
 * The Theme tab's Auto option says what Auto does where the planner runs: a
 * planner nested in a host's theme provider follows the host's scheme (#5030),
 * a standalone one follows the device.
 */
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import Fixture from './planner-theme-host.fixture.svelte';

let app: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
const settle = async () => {
  for (let n = 0; n < 12; n++) await tick();
};
beforeEach(() => {
  cookbookStore.reset();
  location.hash = '#/configure/theme/';
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
  vi.unstubAllGlobals();
  cookbookStore.reset();
  location.hash = '';
});

async function autoHint(hosted: boolean): Promise<string | undefined> {
  app = mount(Fixture, { target, props: { hosted } });
  await settle();
  const auto = [
    ...target.querySelectorAll<HTMLElement>('.smrt-theme-section__scheme'),
  ].find((button) => button.textContent?.includes('Auto'));
  return auto?.querySelector('.smrt-theme-section__hint')?.textContent?.trim();
}

it('says Auto follows the device when the planner stands alone', async () => {
  expect(await autoHint(false)).toBe('Follow this device');
});

it('says Auto matches the surrounding app when hosted', async () => {
  expect(await autoHint(true)).toBe('Match the surrounding app');
});
