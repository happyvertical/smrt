import { ChatService } from '@happyvertical/smrt-chat';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  PromptOverrideCollection,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentEditorSessionPrompt } from './content-chat-prompts';
import { Contents } from './contents';
import {
  GET as getContentChat,
  POST as postContentChat,
} from './routes/api/v1/contents/[id]/chat/+server';
import { POST as postContentChatThread } from './routes/api/v1/contents/[id]/chat/threads/[threadId]/+server';

let currentContents: Contents | undefined;
const getAIMock = vi.fn();

vi.mock('@happyvertical/ai', () => ({
  getAI: (...args: any[]) => getAIMock(...args),
}));

vi.mock('$lib/server/smrt', () => {
  return {
    getCollection: async () => {
      if (!currentContents) {
        throw new Error('Test collection not initialized');
      }

      return currentContents;
    },
    getSmrtConfig: () => ({
      ai: {},
    }),
  };
});

vi.mock('@sveltejs/kit', () => {
  return {
    json: (data: any, init?: any) =>
      new Response(JSON.stringify(data), {
        status: init?.status || 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
});

describe('content chat prompt integration', () => {
  let db: DatabaseInterface;
  let overrides: PromptOverrideCollection;

  beforeEach(async () => {
    clearCache();
    clearPromptCache();
    PromptRegistry.clear();
    PromptRegistry.register(contentEditorSessionPrompt as any);

    setConfig({
      packages: {
        prompts: {
          profiles: {
            deep: {
              provider: 'openai',
              model: 'gpt-4o',
            },
          },
          allowedModels: ['gpt-4o'],
        },
      },
    });

    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    currentContents = await Contents.create({
      tenantId: 'tenant-a',
      db,
    });
    overrides = await PromptOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearCache();
    clearPromptCache();
    PromptRegistry.clear();
    currentContents = undefined;
    getAIMock.mockReset();

    if (typeof (db as any)?.close === 'function') {
      await (db as any).close();
    }
  });

  async function unwrapJson(response: Response) {
    return response.json();
  }

  it('creates tenant-specific content editor sessions from resolved prompts', async () => {
    const content = await currentContents?.create({
      tenantId: 'tenant-a',
      name: 'draft-1',
      title: 'Draft 1',
      body: 'Initial body',
    });

    await overrides.create({
      key: contentEditorSessionPrompt.key,
      tenantId: 'tenant-a',
      template: 'Tenant A content editor prompt',
      profile: 'deep',
      params: {
        temperature: 0.3,
        maxTokens: 1500,
      },
    });

    const tenantAResponse = await getContentChat({
      params: { id: content.id },
      locals: {
        tenantId: 'tenant-a',
        profileId: 'profile-a',
      },
    } as any);
    const tenantAData = await unwrapJson(tenantAResponse);

    expect(tenantAResponse.status).toBe(200);
    expect(tenantAData.session).toBeDefined();

    const tenantAChat = await ChatService.create({ tenantId: 'tenant-a', db });
    const tenantASessions = await tenantAChat.agentSessions.list({
      where: {
        agentId: 'content_editor',
        participantProfileId: 'profile-a',
        status: 'active',
      },
    });

    expect(tenantASessions).toHaveLength(1);
    expect(tenantASessions[0].systemPrompt).toBe(
      'Tenant A content editor prompt',
    );
    expect(tenantASessions[0].getSessionContext()).toMatchObject({
      contentId: content.id,
      profile: 'deep',
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.3,
      maxTokens: 1500,
    });

    const tenantBResponse = await getContentChat({
      params: { id: content.id },
      locals: {
        tenantId: 'tenant-b',
        profileId: 'profile-b',
      },
    } as any);

    expect(tenantBResponse.status).toBe(200);

    const tenantBChat = await ChatService.create({ tenantId: 'tenant-b', db });
    const tenantBSessions = await tenantBChat.agentSessions.list({
      where: {
        agentId: 'content_editor',
        participantProfileId: 'profile-b',
        status: 'active',
      },
    });

    expect(tenantBSessions).toHaveLength(1);
    expect(tenantBSessions[0].systemPrompt).toBe(
      contentEditorSessionPrompt.template,
    );
    expect(tenantBSessions[0].getSessionContext()).toMatchObject({
      contentId: content.id,
      temperature: 0.7,
      maxTokens: 2000,
    });
    expect(tenantBSessions[0].getSessionContext()).not.toHaveProperty(
      'provider',
    );
    expect(tenantBSessions[0].getSessionContext()).not.toHaveProperty('model');
  });

  it('preserves an existing session systemPrompt as the runtime override seam', async () => {
    const content = await currentContents?.create({
      tenantId: 'tenant-a',
      name: 'draft-2',
      title: 'Draft 2',
      body: 'Another body',
    });

    const chatService = await ChatService.create({ tenantId: 'tenant-a', db });
    await chatService.initialize();

    const { session } = await chatService.createAgentSession({
      tenantId: 'tenant-a',
      agentId: 'content_editor',
      participantProfileId: 'profile-a',
      systemPrompt: 'Manual session prompt',
    });
    await session.updateSessionContext({
      contentId: content.id,
    });

    const response = await getContentChat({
      params: { id: content.id },
      locals: {
        tenantId: 'tenant-a',
        profileId: 'profile-a',
      },
    } as any);
    const data = await unwrapJson(response);

    expect(response.status).toBe(200);
    expect(data.session.id).toBe(session.id);

    const persisted = await chatService.agentSessions.get(session.id as string);
    expect(persisted?.systemPrompt).toBe('Manual session prompt');
  });

  it('updates provider alongside model changes when creating a new topic', async () => {
    const content = await currentContents?.create({
      tenantId: 'tenant-a',
      name: 'draft-3',
      title: 'Draft 3',
      body: 'Body',
    });

    const chatService = await ChatService.create({ tenantId: 'tenant-a', db });
    await chatService.initialize();

    const { session } = await chatService.createAgentSession({
      tenantId: 'tenant-a',
      agentId: 'content_editor',
      participantProfileId: 'profile-a',
      systemPrompt: 'Manual session prompt',
    });
    await session.updateSessionContext({
      contentId: content.id,
      provider: 'openai',
      model: 'gpt-4o',
    });

    const response = await postContentChat({
      params: { id: content.id },
      request: {
        json: async () => ({
          title: 'Rewrite',
          sessionId: session.id,
          model: 'claude-3-5-haiku-latest',
        }),
      },
      locals: {
        tenantId: 'tenant-a',
        profileId: 'profile-a',
      },
    } as any);

    expect(response.status).toBe(200);

    const updated = await chatService.agentSessions.get(session.id as string);
    expect(updated?.getSessionContext()).toMatchObject({
      contentId: content.id,
      model: 'claude-3-5-haiku-latest',
      provider: 'anthropic',
    });
  });

  it('keeps the stored provider when creating a topic with the current model', async () => {
    const content = await currentContents?.create({
      tenantId: 'tenant-a',
      name: 'draft-3b',
      title: 'Draft 3b',
      body: 'Body',
    });

    const chatService = await ChatService.create({ tenantId: 'tenant-a', db });
    await chatService.initialize();

    const { session } = await chatService.createAgentSession({
      tenantId: 'tenant-a',
      agentId: 'content_editor',
      participantProfileId: 'profile-a',
      systemPrompt: 'Manual session prompt',
    });
    await session.updateSessionContext({
      contentId: content.id,
      provider: 'openrouter',
      model: 'gpt-4o',
    });

    const response = await postContentChat({
      params: { id: content.id },
      request: {
        json: async () => ({
          title: 'General',
          sessionId: session.id,
          model: 'gpt-4o',
        }),
      },
      locals: {
        tenantId: 'tenant-a',
        profileId: 'profile-a',
      },
    } as any);

    expect(response.status).toBe(200);

    const updated = await chatService.agentSessions.get(session.id as string);
    expect(updated?.getSessionContext()).toMatchObject({
      contentId: content.id,
      model: 'gpt-4o',
      provider: 'openrouter',
    });
  });

  it('preserves the stored provider when the UI resubmits the current model', async () => {
    const content = await currentContents?.create({
      tenantId: 'tenant-a',
      name: 'draft-4',
      title: 'Draft 4',
      body: 'Body',
    });

    const chatService = await ChatService.create({ tenantId: 'tenant-a', db });
    await chatService.initialize();

    const { session } = await chatService.createAgentSession({
      tenantId: 'tenant-a',
      agentId: 'content_editor',
      participantProfileId: 'profile-a',
      systemPrompt: 'Provider-aware prompt',
    });
    await session.updateSessionContext({
      contentId: content.id,
      provider: 'openrouter',
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 321,
    });
    const chatRoomId = session.chatRoomId;
    if (!chatRoomId) {
      throw new Error('Expected content editor session to create a chat room');
    }

    const thread = await chatService.threads.create({
      tenantId: 'tenant-a',
      roomId: chatRoomId,
      title: 'General',
      messageCount: 0,
    });

    getAIMock.mockResolvedValue({
      chat: vi.fn(async () => ({ content: 'Assistant reply' })),
    });

    const response = await postContentChatThread({
      params: { id: content.id, threadId: thread.id },
      request: {
        json: async () => ({
          content: 'Please improve the intro.',
          sessionId: session.id,
          model: 'gpt-4o',
          currentEditorState: content.body,
          referenceIds: [],
          formFields: {
            title: content.title,
            body: content.body,
          },
        }),
      },
      locals: {
        tenantId: 'tenant-a',
        profileId: 'profile-a',
      },
    } as any);

    expect(response.status).toBe(200);
    expect(getAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        model: 'gpt-4o',
      }),
    );
  });
});
