import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from '../../test/app-state.ts';
import Page from './+page.svelte';

const navigation = vi.hoisted(() => ({
  goto: vi.fn(async () => {}),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock('$app/navigation', () => navigation);
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('keeps Fresh selected and completes onboarding before opening a spreadsheet import', async () => {
  page.url = new URL('http://localhost/welcome?step=2');
  const send = vi.fn(
    async () => new Response(JSON.stringify({ onboarding: 'fresh' })),
  );
  vi.stubGlobal('fetch', send);
  component = mount(Page, { target: document.body });
  await tick();
  expect(
    document.querySelector<HTMLInputElement>('input[value="fresh"]')?.checked,
  ).toBe(true);
  expect(document.body.textContent).toContain('From a spreadsheet');
  document
    .querySelector<HTMLInputElement>('input[value="spreadsheet"]')
    ?.click();
  await tick();
  document
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(send).toHaveBeenCalledWith(
    '/api/shell/onboarding/complete?target=live',
    expect.objectContaining({ body: JSON.stringify({ start: 'fresh' }) }),
  );
  expect(navigation.invalidateAll).toHaveBeenCalledOnce();
  expect(navigation.goto).toHaveBeenCalledWith('/import');
});
