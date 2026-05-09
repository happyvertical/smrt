import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import {
  createContentEditorChatThread,
  getOrCreateContentEditorChatSession,
} from '../../../../../../content-chat-handlers.js';

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
    const tenantId = smrtLocals.tenantId || 'global';
    const profileId = smrtLocals.profileId || smrtLocals.user?.id || 'system';
    const { session, threads } = await getOrCreateContentEditorChatSession({
      db: contents.db,
      tenantId,
      profileId,
      contentId: id,
    });

    return json({
      session,
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
    const tenantId = smrtLocals.tenantId || 'global';
    const profileId = smrtLocals.profileId || smrtLocals.user?.id || 'system';

    const { session, thread } = await createContentEditorChatThread({
      db: contents.db,
      tenantId,
      profileId,
      contentId: id,
      title,
      sessionId,
      model,
      initializeChatCollections: async () => {
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
      },
    });

    return json({
      thread,
      session,
    });
  } catch (error: any) {
    if (error?.message === 'Active session not found') {
      return json({ error: error.message }, { status: 404 });
    }
    if (error?.message === 'Active session is missing a chat room') {
      return json({ error: error.message }, { status: 500 });
    }
    console.error(`Error sending message for content ${id}:`, error);
    return json({ error: 'Failed to process message' }, { status: 500 });
  }
};
