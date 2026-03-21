// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-chat/svelte', async () => ({
  AgentChat: (await import('../../../test-stubs/AgentChatStub.svelte')).default,
}));

import ContentAgentChat from './ContentAgentChat.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderChat(props: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentAgentChat, {
    target,
    props,
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('ContentAgentChat component', () => {
  it('uses a custom apiBaseUrl for session and thread requests', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: 'session-1', allowedTools: '[]' },
          threads: [{ id: 'thread-1', title: 'General' }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [],
        }),
      } as Response);

    renderChat({
      apiBaseUrl: '/tenant/api/v2',
      contentId: 'content-1',
    });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        '/tenant/api/v2/contents/content-1/chat',
      ),
    );

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        '/tenant/api/v2/contents/content-1/chat/threads/thread-1',
      ),
    );
  });
});
