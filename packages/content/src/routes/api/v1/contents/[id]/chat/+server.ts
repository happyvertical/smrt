import { json } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import { ChatService } from '@happyvertical/smrt-chat';

export async function GET({ params, locals }) {
  const { id } = params;

  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  try {
    const contents = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const db = contents.db;

    const tenantId = locals.tenantId || 'global';
    const chatService = await ChatService.create({ tenantId, db });
    await chatService.initialize();

    const profileId = locals.profileId || locals.user?.id || 'system';

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
      const { session } = await chatService.createAgentSession({
        tenantId,
        agentId: 'content_editor',
        participantProfileId: profileId,
        systemPrompt:
          'You are an AI assistant collaborating with the user to edit and improve a specific piece of content.',
      });
      await session.updateSessionContext({ contentId: id });
      activeSession = session;
    }

    let threads: any[] = [];
    try {
      threads = await chatService.threads.list({
        where: { roomId: activeSession.chatRoomId! },
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
    console.error(`Error fetching chat for content ${id}:`, error);
    return json(
      { error: error.message || 'Failed to find or create chat session' },
      { status: 500 },
    );
  }
}

export async function POST({ params, request, locals }) {
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

    const tenantId = locals.tenantId || 'global';
    const chatService = await ChatService.create({ tenantId, db: contents.db });

    const session = await chatService.agentSessions.get(sessionId);

    if (!session || !session.isActive()) {
      return json({ error: 'Active session not found' }, { status: 404 });
    }

    // Create a new thread directly in the collection
    const thread = await chatService.threads.create({
      tenantId,
      roomId: session.chatRoomId!,
      title,
      messageCount: 0,
    });

    // If model changed, update context
    if (model) {
      const ctx = session.getSessionContext();
      if (ctx.model !== model) {
        await session.updateSessionContext({ model: model });
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
}
