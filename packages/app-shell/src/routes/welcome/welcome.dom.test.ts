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

const hostedState = {
  engine: 'api',
  hosted: true,
  apiReady: false,
  onboarding: null,
  tools: [],
  chatgpt: { signedIn: false, signingIn: false },
};

it('hosted: the connect step offers only the API key (no ChatGPT, no local tool)', async () => {
  page.url = new URL('http://localhost/welcome');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(hostedState))),
  );
  component = mount(Page, {
    target: document.body,
    props: { data: { hosted: true } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  const text = document.body.textContent ?? '';
  expect(text).toMatch(/your\s+own\s+API key/);
  expect(text).not.toMatch(/ChatGPT|Claude Code|Codex/);
  expect(document.querySelector('#chatgpt')).toBeNull();
});

it('hosted: no spreadsheet start (the desktop’s workbook import is refused there)', async () => {
  page.url = new URL('http://localhost/welcome?step=2');
  component = mount(Page, {
    target: document.body,
    props: { data: { hosted: true } },
  });
  await tick();
  expect(document.body.textContent).toContain('Fresh');
  expect(document.body.textContent).not.toContain('From a spreadsheet');
  expect(document.querySelector('input[value="spreadsheet"]')).toBeNull();
});
