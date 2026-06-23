import { createLogger } from '@happyvertical/logger';
import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import {
  createContentEditorChatThread,
  getOrCreateContentEditorChatSession,
} from '../../../../../../content-chat-handlers.js';
import {
  type ContentChatRouteLocals,
  requestHasTrustedOrigin,
  resolveContentChatProfileId,
} from '../../../../../../content-chat-route-helpers.js';

const logger = createLogger({ level: 'info' });

export const GET: RequestHandler = async ({ params, request, locals }) => {
  const smrtLocals = locals as ContentChatRouteLocals;
  const { id } = params;

  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }
  // This GET mutates state (getOrCreateContentEditorChatSession creates a
  // session/room), so it needs the same CSRF-style origin guard the POST path
  // already enforces (#1387 minor).
  if (!requestHasTrustedOrigin(request)) {
    return json({ error: 'Invalid request origin' }, { status: 403 });
  }

  try {
    const contents = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const tenantId = smrtLocals.tenantId || null;
    const profileId = resolveContentChatProfileId(smrtLocals);
    if (!profileId) {
      return json({ error: 'Authentication required' }, { status: 401 });
    }
    const { session, threads } = await getOrCreateContentEditorChatSession({
      db: contents.db,
      contents,
      tenantId,
      profileId,
      contentId: id,
    });

    return json({
      session,
      threads,
    });
  } catch (error: any) {
    if (error?.message === 'Content not found') {
      return json({ error: error.message }, { status: 404 });
    }
    // Gracefully handle missing chat tables (cross-package dependency)
    if (error?.code === 'DB_SCHEMA_MISSING') {
      return json({
        session: null,
        threads: [],
        notice:
          'Chat tables not yet provisioned. Run smrt db:migrate to enable.',
      });
    }
    logger.error(`Error fetching chat for content ${id}`, { error });
    return json(
      { error: error.message || 'Failed to find or create chat session' },
      { status: 500 },
    );
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const smrtLocals = locals as ContentChatRouteLocals;
  const { id } = params;
  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }
  if (!requestHasTrustedOrigin(request)) {
    return json({ error: 'Invalid request origin' }, { status: 403 });
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
    const tenantId = smrtLocals.tenantId || null;
    const profileId = resolveContentChatProfileId(smrtLocals);
    if (!profileId) {
      return json({ error: 'Authentication required' }, { status: 401 });
    }

    const { session, thread } = await createContentEditorChatThread({
      db: contents.db,
      contents,
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
    if (error?.message === 'Content not found') {
      return json({ error: error.message }, { status: 404 });
    }
    if (error?.message === 'AI model is not allowed for content chat') {
      return json({ error: error.message }, { status: 400 });
    }
    if (error?.message === 'Active session is missing a chat room') {
      return json({ error: error.message }, { status: 500 });
    }
    logger.error(`Error sending message for content ${id}`, { error });
    return json({ error: 'Failed to process message' }, { status: 500 });
  }
};
