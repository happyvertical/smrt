import { mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ConnectAi from '../components/ConnectAi.svelte';
import { postSetting } from '../ui/settings-client.ts';
import AssistantPanel from './AssistantPanel.svelte';

vi.mock('$app/forms', () => ({ deserialize: JSON.parse }));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
let components: ReturnType<typeof mount>[] = [];
let container: HTMLDivElement;
afterEach(async () => {
  for (const component of components) await unmount(component);
  components = [];
  container?.remove();
  vi.unstubAllGlobals();
});

it('refreshes the open composer after engine selection, ChatGPT sign-out and a saved key', async () => {
  let engine = 'api';
  let configured = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input);
      if (path.includes('/connect')) {
        engine = 'claude-code';
        configured = true;
      }
      if (path.includes('/engine')) {
        engine = JSON.parse(init.body).engine;
        configured = true;
      }
      if (path.includes('/chatgpt') && init?.method === 'POST')
        configured = false;
      if (path.startsWith('?/saveKey')) {
        engine = 'api';
        configured = true;
        return new Response(JSON.stringify({ type: 'success', data: {} }));
      }
      const body = path.includes('/status')
        ? {
            configured,
            engine,
            engineLabel:
              engine === 'claude-code'
                ? 'Claude Code'
                : engine === 'chatgpt'
                  ? 'ChatGPT'
                  : 'an API key',
            message: 'Add a key',
          }
        : path.includes('/onboarding')
          ? {
              engine,
              apiReady: false,
              onboarding: null,
              chatgpt: {
                signedIn: engine !== 'chatgpt' || configured,
                signingIn: false,
              },
              tools: [
                {
                  tool: 'claude-code',
                  label: 'Claude Code',
                  installed: true,
                  signedIn: true,
                  login: 'idle',
                },
              ],
            }
          : { threads: [], approvals: [] };
      return new Response(JSON.stringify(body));
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  components.push(
    mount(AssistantPanel, { target: container, props: { open: true } }),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('textarea')?.disabled).toBe(true),
  );
  components.push(
    mount(ConnectAi, { target: container, props: { variant: 'settings' } }),
  );
  const click = async (text: string) => {
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll('button')].some(
          (b) => b.textContent?.trim() === text,
        ),
      ).toBe(true),
    );
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === text)
      ?.click();
  };
  await click('Use Claude Code');
  await vi.waitFor(() => {
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    expect(container.querySelector('#assistant-panel')?.textContent).toContain(
      'Using Claude Code',
    );
  });
  await click('Use ChatGPT');
  await vi.waitFor(() =>
    expect(container.querySelector('#assistant-panel')?.textContent).toContain(
      'Using ChatGPT',
    ),
  );
  await click('Sign out');
  await vi.waitFor(() =>
    expect(container.querySelector('textarea')?.disabled).toBe(true),
  );
  await postSetting('saveKey', { provider: 'test', key: 'stub' });
  await vi.waitFor(() =>
    expect(container.querySelector('textarea')?.disabled).toBe(false),
  );
});
