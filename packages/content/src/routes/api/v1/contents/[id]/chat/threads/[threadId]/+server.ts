import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection, getSmrtConfig } from '$lib/server/smrt';
import {
  type ContentChatAIConfig,
  contentChatMessageToJSON,
  listContentEditorChatThreadMessages,
  sendContentEditorChatThreadMessage,
  serializeContentChatMessageForUI,
} from '../../../../../../../../content-chat-handlers.js';
import {
  type ContentChatRouteLocals,
  requestHasTrustedOrigin,
  resolveContentChatProfileId,
} from '../../../../../../../../content-chat-route-helpers.js';

export const GET: RequestHandler = async ({ params, locals }) => {
  const smrtLocals = locals as ContentChatRouteLocals;
  const { id, threadId } = params;

  if (!threadId) {
    return json({ error: 'Thread ID is required' }, { status: 400 });
  }
  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const tenantId = smrtLocals.tenantId || null;
    const profileId = resolveContentChatProfileId(smrtLocals);
    if (!profileId) {
      return json({ error: 'Authentication required' }, { status: 401 });
    }
    const { thread, messages } = await listContentEditorChatThreadMessages({
      db: contentsCollection.db,
      contents: contentsCollection,
      tenantId,
      profileId,
      contentId: id,
      threadId,
    });

    return json({
      thread,
      messages: messages.map(serializeContentChatMessageForUI),
    });
  } catch (error: any) {
    if (
      error?.message === 'Thread not found' ||
      error?.message === 'Content not found'
    ) {
      return json({ error: error.message }, { status: 404 });
    }
    console.error(`Error fetching messages for thread ${threadId}:`, error);
    return json({ error: 'Failed to find thread messages' }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const smrtLocals = locals as ContentChatRouteLocals;
  const { id, threadId } = params;
  if (!id || !threadId) {
    return json(
      { error: 'Content ID and Thread ID are required' },
      { status: 400 },
    );
  }
  if (!requestHasTrustedOrigin(request)) {
    return json({ error: 'Invalid request origin' }, { status: 403 });
  }

  const {
    content: messageContent,
    sessionId,
    model,
    currentEditorState,
    referenceIds,
    formFields,
  } = await request.json();

  if (!messageContent || !sessionId) {
    return json(
      { error: 'Message content and sessionId are required' },
      { status: 400 },
    );
  }

  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const tenantId = smrtLocals.tenantId || null;
    const profileId = resolveContentChatProfileId(smrtLocals);
    if (!profileId) {
      return json({ error: 'Authentication required' }, { status: 401 });
    }

    const config = getSmrtConfig('@happyvertical/smrt-content:Content');
    const aiConfig = (config.ai || {}) as ContentChatAIConfig;
    const { session, userMessage, agentMessage } =
      await sendContentEditorChatThreadMessage({
        contents: contentsCollection,
        tenantId,
        profileId,
        contentId: id,
        threadId,
        content: messageContent,
        sessionId,
        model,
        currentEditorState,
        referenceIds,
        formFields,
        aiConfig,
      });

    const userJson = serializeContentChatMessageForUI(userMessage);
    const agentJson = serializeContentChatMessageForUI(agentMessage);
    const sessionJson = contentChatMessageToJSON(session);

    return json({
      userMessage: userJson,
      agentMessage: agentJson,
      session: sessionJson,
    });
  } catch (error: any) {
    if (
      error?.message === 'Active session not found' ||
      error?.message === 'Thread not found' ||
      error?.message === 'Content not found'
    ) {
      return json({ error: error.message }, { status: 404 });
    }
    if (error?.message === 'Active session is missing a chat room') {
      return json({ error: error.message }, { status: 500 });
    }
    if (error?.message === 'AI model is not allowed for content chat') {
      return json({ error: error.message }, { status: 400 });
    }
    console.error(`Error processing message for thread ${threadId}:`, error);
    return json(
      { error: error.message || 'Failed to process message' },
      { status: 500 },
    );
  }
};
