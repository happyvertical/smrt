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

  it('uses the session context model when auto-creating the first topic', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            id: 'session-1',
            allowedTools: '[]',
            sessionContext: JSON.stringify({ model: 'gpt-4o' }),
          },
          threads: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          thread: { id: 'thread-1', title: 'General' },
          session: { id: 'session-1' },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [],
        }),
      } as Response);

    renderChat({
      contentId: 'content-1',
    });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        '/api/v1/contents/content-1/chat',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'General',
            sessionId: 'session-1',
            model: 'gpt-4o',
            referenceIds: [],
          }),
        }),
      ),
    );
  });

  it('can be hosted from an external assistant context', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: 'session-1', allowedTools: '[]' },
          threads: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          thread: { id: 'thread-1', title: 'General' },
          session: { id: 'session-1' },
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
      assistantContext: {
        type: 'content.editor',
        title: 'External assistant article',
        data: {
          contentId: 'content-from-context',
          contentType: 'article',
          editorKind: 'governed',
          currentEditorState: 'Draft body from editor',
          referenceIds: ['ref-1'],
          fields: {
            title: 'External assistant article',
            body: 'Draft body from editor',
          },
        },
      },
    });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        '/tenant/api/v2/contents/content-from-context/chat',
      ),
    );

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        '/tenant/api/v2/contents/content-from-context/chat',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            title: 'General',
            sessionId: 'session-1',
            model: 'gemini-2.5-pro',
            referenceIds: ['ref-1'],
          }),
        }),
      ),
    );
  });
});
