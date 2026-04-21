import { type AIClientOptions, getAI } from '@happyvertical/ai';
import { ChatService } from '@happyvertical/smrt-chat';
import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection, getSmrtConfig } from '$lib/server/smrt';

type ContentChatLocals = {
  tenantId?: string | null;
  profileId?: string | null;
  user?: {
    id?: string | null;
  } | null;
};

function inferProviderFromModel(model: string): string {
  if (model.includes('claude')) {
    return 'anthropic';
  }

  if (model.includes('gemini')) {
    return 'gemini';
  }

  return 'openai';
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const smrtLocals = locals as ContentChatLocals;
  const { threadId } = params;

  if (!threadId) {
    return json({ error: 'Thread ID is required' }, { status: 400 });
  }

  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const tenantId = smrtLocals.tenantId || 'global';
    const chatService = await ChatService.create({
      tenantId,
      db: contentsCollection.db,
    });

    const thread = await chatService.threads.get(threadId);
    if (!thread) {
      return json({ error: 'Thread not found' }, { status: 404 });
    }

    // Load recent messages for this thread natively
    const messages = await chatService.messages.list({
      where: { threadId: threadId },
      orderBy: 'createdAt DESC',
      limit: 100,
    });

    const uiMessages = messages.reverse().map((msg) => {
      const m = msg.toJSON();
      m.senderName = msg.role === 'user' ? 'You' : 'AI Assistant';
      m.senderAvatarUrl = '';
      return m;
    });

    return json({
      thread,
      messages: uiMessages,
    });
  } catch (error) {
    console.error(`Error fetching messages for thread ${threadId}:`, error);
    return json({ error: 'Failed to find thread messages' }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const smrtLocals = locals as ContentChatLocals;
  const { id, threadId } = params;
  if (!id || !threadId) {
    return json(
      { error: 'Content ID and Thread ID are required' },
      { status: 400 },
    );
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
    const tenantId = smrtLocals.tenantId || 'global';
    const chatService = await ChatService.create({
      tenantId,
      db: contentsCollection.db,
    });
    const profileId = smrtLocals.profileId || smrtLocals.user?.id || 'system';

    const session = await chatService.agentSessions.get(sessionId);
    if (!session || !session.isActive()) {
      return json({ error: 'Active session not found' }, { status: 404 });
    }

    const thread = await chatService.threads.get(threadId);
    if (!thread) {
      return json({ error: 'Thread not found' }, { status: 404 });
    }

    const chatRoomId = session.chatRoomId;
    if (!chatRoomId) {
      return json(
        { error: 'Active session is missing a chat room' },
        { status: 500 },
      );
    }

    // Save user message attached to thread
    const userMessage = await chatService.sendMessage({
      tenantId,
      roomId: chatRoomId,
      threadId: thread.id,
      senderProfileId: profileId,
      content: messageContent,
      role: 'user',
      agentSessionId: session.id,
    });

    // Load any references that are attached to this content editor
    let combinedReferences = '';
    if (
      referenceIds &&
      Array.isArray(referenceIds) &&
      referenceIds.length > 0
    ) {
      const refTexts = [];
      for (const refId of referenceIds) {
        const ref = await contentsCollection.get(refId);
        if (ref) {
          refTexts.push(`--- REFERENCE: ${ref.title} ---\n${ref.body}`);
        }
      }
      if (refTexts.length > 0) {
        combinedReferences = `\n\nATTACHED REFERENCE MATERIALS:\n${refTexts.join('\n\n')}\n`;
      }
    }

    // Build context from all form fields so the AI can see and update any field
    const fields = formFields || {};
    const contextPrompt = `
CURRENT CONTENT FORM STATE:
- title: ${fields.title || '(empty)'}
- description: ${fields.description || '(empty)'}
- type: ${fields.type || 'article'}
- status: ${fields.status || 'draft'}
- state: ${fields.state || 'active'}
- body:
${fields.body || currentEditorState || '(empty)'}
${combinedReferences}

INSTRUCTIONS FOR CO-AUTHORING:
You are a content co-author. You can update ANY of the above fields.

When you want to make changes to the content, output a JSON code block with a "fields" object containing ONLY the fields you want to change:

\`\`\`json
{"fields": {"title": "New Title", "body": "New body content..."}}
\`\`\`

Valid field names: title, description, type, status, state, body.
Valid status values: draft, published, archived.
Valid state values: active, highlighted, deprecated.
Valid type values: article, document, mirror.

RULES:
- Only include fields you are actually changing.
- If the user asks to write/rewrite content, update the "body" field.
- If the user asks to change the title, update the "title" field.
- You can change multiple fields at once.
- Always respond conversationally BEFORE the JSON block.
- The JSON block will be automatically applied to the editor.
`;

    // Fetch previous messages in this thread for context history
    const history = await chatService.messages.list({
      where: { threadId: thread.id },
      orderBy: 'createdAt DESC',
      limit: 10,
    });

    const conversation = history.reverse().map((m: any) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    const config = getSmrtConfig('@happyvertical/smrt-content:Content');
    const aiConfig = (config.ai || {}) as AIClientOptions;

    // Get SvelteKit environment variables for SSR
    const env = process.env;

    const ctx = session.getSessionContext();
    const storedModel =
      typeof ctx.model === 'string' && ctx.model.length > 0 ? ctx.model : null;
    const storedProvider =
      typeof ctx.provider === 'string' && ctx.provider.length > 0
        ? ctx.provider
        : null;
    const defaultModel = storedModel ?? 'gemini-2.5-pro';
    const aiModel = model || defaultModel;
    const provider =
      storedProvider && storedModel && aiModel === storedModel
        ? storedProvider
        : inferProviderFromModel(aiModel);
    const temperature =
      typeof ctx.temperature === 'number' ? ctx.temperature : 0.7;
    const maxTokens = typeof ctx.maxTokens === 'number' ? ctx.maxTokens : 2000;

    // Explicitly fallback to env vars if config lacks them
    const apiKey =
      aiConfig.apiKey ||
      (provider === 'anthropic'
        ? env.ANTHROPIC_API_KEY
        : provider === 'gemini'
          ? env.GEMINI_API_KEY
          : env.OPENAI_API_KEY);

    const ai = await getAI({
      ...aiConfig,
      provider,
      apiKey,
      model: aiModel,
    } as any);

    const fullSystemPrompt =
      typeof session.systemPrompt === 'string' ? session.systemPrompt : '';
    conversation.unshift({
      role: 'system',
      content: `${fullSystemPrompt}\n\n${contextPrompt}`,
    });

    const response = await ai.chat(conversation, {
      model: aiModel,
      temperature,
      maxTokens,
    });

    // Save agent message
    const agentMessage = await chatService.sendMessage({
      tenantId,
      roomId: chatRoomId,
      agentSessionId: session.id as string,
      threadId: thread.id,
      senderProfileId: session.agentId,
      content: response.content,
      role: 'assistant',
    });

    // If model changed, update context
    if (ctx.model !== aiModel || ctx.provider !== provider) {
      await session.updateSessionContext({ model: aiModel, provider });
    }

    const userJson = userMessage.toJSON();
    userJson.senderName = 'You';

    const agentJson = agentMessage.toJSON();
    agentJson.senderName = 'AI Assistant';
    agentJson.senderAvatarUrl = '';

    return json({
      userMessage: userJson,
      agentMessage: agentJson,
      session: session.toJSON(),
    });
  } catch (error: any) {
    console.error(`Error processing message for thread ${threadId}:`, error);
    return json(
      { error: error.message || 'Failed to process message' },
      { status: 500 },
    );
  }
};
