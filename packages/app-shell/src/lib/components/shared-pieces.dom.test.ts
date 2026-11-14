import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalCard from './ApprovalCard.svelte';
import ConnectAi from './ConnectAi.svelte';

let component: ReturnType<typeof mount> | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});
const target = () => {
  container = document.createElement('div');
  document.body.append(container);
  return container;
};

describe('Tricia shared component adapters', () => {
  it.each([
    'welcome',
    'settings',
  ] as const)('keeps a signed-in but unusable CLI unselectable with its preflight reason in %s', async (variant) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              onboarding: null,
              engine: 'claude-code',
              apiReady: false,
              chatgpt: { signedIn: false, signingIn: false },
              tools: [
                {
                  tool: 'claude-code',
                  label: 'Claude Code',
                  installed: true,
                  signedIn: true,
                  ready: false,
                  startError: 'cli_invocation',
                  version: '3.1.0',
                  login: 'idle',
                  installUrl: 'https://code.claude.com/docs/en/setup',
                },
              ],
            }),
          ),
      ),
    );
    const onchange = vi.fn();
    component = mount(ConnectAi, {
      target: target(),
      props: { variant, onchange },
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'Installed, but not usable in this app.',
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'does not accept the required secure options',
    );
    expect(container.textContent).not.toContain('Ready in this app');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Use Claude Code',
      ),
    ).toBe(false);
    expect(container.textContent).toContain('Check again');
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ engine: 'claude-code' }),
      false,
    );
  });

  it('renders the shared approval card with the full builder preview and original decision callback', async () => {
    const ondecide = vi.fn();
    component = mount(ApprovalCard, {
      target: target(),
      props: {
        approval: {
          id: 'approval-1',
          status: 'pending',
          summary: 'Add Chore.score',
          preview: {
            model: 'Chore',
            method: 'score',
            code: 'return 1;',
            description: 'A score',
          },
          action: { kind: 'command', command: { type: 'addMethod' } },
          requestedBy: 'owner',
          decidedBy: '',
          decidedAt: '',
          result: null,
          createdAt: '2026-11-10T12:00:00Z',
        },
        ondecide,
      },
    });
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[data-smrt-component="AssistantApprovalCard"]',
        ),
      ).toBeTruthy(),
    );
    expect(container.textContent).toContain(
      'Adds code that will run on your data',
    );
    expect(container.querySelector('pre')?.textContent).toBe('return 1;');
    const approve = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approve'),
    );
    expect(approve?.textContent).toMatch(/^Approve/);
    approve?.click();
    expect(ondecide).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    'welcome',
    'settings',
  ] as const)('renders shared ConnectAi with Tricia grouping in %s', async (variant) => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            onboarding: null,
            engine: 'api',
            apiReady: true,
            chatgpt: { signedIn: false, signingIn: false },
            tools: [
              {
                tool: 'claude-code',
                label: 'Claude Code',
                installed: true,
                signedIn: true,
                ready: true,
                version: '3.1.0',
                login: 'idle',
                installUrl: 'https://code.claude.com/docs/en/setup',
              },
              {
                tool: 'codex',
                label: 'Codex',
                installed: true,
                signedIn: true,
                ready: true,
                login: 'idle',
                installUrl: 'https://developers.openai.com/codex/cli',
              },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const onchange = vi.fn();
    component = mount(ConnectAi, {
      target: target(),
      props: { variant, onchange },
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'Ready in this app, version 3.1.0.',
      ),
    );
    expect(
      container.querySelector('[data-smrt-component="ConnectAi"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain(
      "An API key (saved here, or found in this computer's settings).",
    );
    expect(container.textContent).toContain('Codex');
    expect(container.querySelector('details')).toBeNull();
    const text = container.textContent ?? '';
    expect(text.indexOf('Claude Code')).toBeLessThan(text.indexOf('ChatGPT'));
    expect(text.indexOf('ChatGPT')).toBeLessThan(text.indexOf('Codex'));
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ engine: 'api' }),
      true,
    );
    const signal = (
      fetcher.mock.calls[0] as unknown as [unknown, RequestInit]
    )[1].signal;
    await unmount(component);
    component = undefined;
    expect(signal?.aborted).toBe(true);
  });
});
