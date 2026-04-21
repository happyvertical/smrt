import { ChatService } from '@happyvertical/smrt-chat';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import { contentEditorSessionPrompt } from '../../../../../../content-chat-prompts.js';
import {
  buildContentEditorSessionContext,
  resolveContentChatModelSelection,
} from '../../../../../../content-chat-session.js';

type ContentChatLocals = {
  tenantId?: string | null;
  profileId?: string | null;
  user?: {
    id?: string | null;
  } | null;
};

export const GET: RequestHandler = async ({ params, locals }) => {
  const smrtLocals = locals as ContentChatLocals;
  const { id } = params;

  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  try {
    const contents = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const db = contents.db;

    const tenantId = smrtLocals.tenantId || 'global';
    const chatService = await ChatService.create({ tenantId, db });
    await chatService.initialize();

    const profileId = smrtLocals.profileId || smrtLocals.user?.id || 'system';

    // Find existing session for this content
    let activeSession = null;
    try {
      const agentSessions = await chatService.agentSessions.list({
        where: {
          agentId: 'content_editor',
          participantProfileId: profileId,
          status: 'active',
        },
      });
      for (const session of agentSessions) {
        const ctx = session.getSessionContext();
        if (ctx.contentId === id) {
          activeSession = session;
          break;
        }
      }
    } catch {
      // Table schema may not exist yet — will be created by createAgentSession
    }

    if (!activeSession) {
      const resolvedPrompt = await resolvePrompt(
        contentEditorSessionPrompt.key,
        {
          db,
          tenantId,
        },
      );
      const { session } = await chatService.createAgentSession({
        tenantId,
        agentId: 'content_editor',
        participantProfileId: profileId,
        systemPrompt: resolvedPrompt.text,
      });
      await session.updateSessionContext(
        buildContentEditorSessionContext(id, resolvedPrompt),
      );
      activeSession = session;
    }

    let threads: any[] = [];
    try {
      const chatRoomId = activeSession.chatRoomId;
      if (!chatRoomId) {
        throw new Error('Agent session is missing a chat room');
      }
      threads = await chatService.threads.list({
        where: { roomId: chatRoomId },
        orderBy: 'createdAt DESC',
      });
    } catch {
      // Threads table may not exist yet
    }

    return json({
      session: activeSession,
      threads,
    });
  } catch (error: any) {
    // Gracefully handle missing chat tables (cross-package dependency)
    if (error?.code === 'DB_SCHEMA_MISSING') {
      return json({
        session: null,
        threads: [],
        notice:
          'Chat tables not yet provisioned. Run smrt db:migrate to enable.',
      });
    }
    console.error(`Error fetching chat for content ${id}:`, error);
    return json(
      { error: error.message || 'Failed to find or create chat session' },
      { status: 500 },
    );
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const smrtLocals = locals as ContentChatLocals;
  const { id } = params;
  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  const { title, sessionId, model } = await request.json();

  if (!title || !sessionId) {
    return json(
      { error: 'Title and sessionId are required to start a topic' },
      { status: 400 },
    );
  }

  try {
    const contents = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );

    // Explicitly initialize the chat collections via getCollection to trigger SMRT lazy table creation
    await getCollection('@happyvertical/smrt-chat:AgentSession', {
      db: contents.db,
    });
    await getCollection('@happyvertical/smrt-chat:ChatThread', {
      db: contents.db,
    });
    await getCollection('@happyvertical/smrt-chat:ChatRoom', {
      db: contents.db,
    });
    await getCollection('@happyvertical/smrt-chat:ChatMessage', {
      db: contents.db,
    });
    await getCollection('@happyvertical/smrt-chat:ChatParticipant', {
      db: contents.db,
    });

    const tenantId = smrtLocals.tenantId || 'global';
    const chatService = await ChatService.create({ tenantId, db: contents.db });

    const session = await chatService.agentSessions.get(sessionId);

    if (!session || !session.isActive()) {
      return json({ error: 'Active session not found' }, { status: 404 });
    }

    const chatRoomId = session.chatRoomId;
    if (!chatRoomId) {
      return json(
        { error: 'Active session is missing a chat room' },
        { status: 500 },
      );
    }

    // Create a new thread directly in the collection
    const thread = await chatService.threads.create({
      tenantId,
      roomId: chatRoomId,
      title,
      messageCount: 0,
    });

    // If model changed, update context
    if (model) {
      const ctx = session.getSessionContext();
      const { provider } = resolveContentChatModelSelection(ctx, model, model);
      if (ctx.model !== model || ctx.provider !== provider) {
        await session.updateSessionContext({
          model,
          provider,
        });
      }
    }

    return json({
      thread,
      session,
    });
  } catch (error) {
    console.error(`Error sending message for content ${id}:`, error);
    return json({ error: 'Failed to process message' }, { status: 500 });
  }
};
