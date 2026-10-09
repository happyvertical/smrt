import type { DevCharacterConversationProposal } from './routes/api/dev-character-conversation/protocol.js';
import {
  DEV_CHARACTER_MAX_MESSAGES,
  DEV_CHARACTER_MAX_REQUEST_BYTES,
} from './routes/api/dev-character-conversation/protocol.js';
import type {
  AssistantMessage,
  AssistantSendMessageInput,
  AssistantSendMessageResult,
  AssistantThreadSummary,
  AssistantTransport,
} from './svelte/components/assistant/assistant-transport.js';

/** A development-only transport backed by the real local AI route. */
export function createDevAssistantTransport(
  request: typeof fetch = fetch,
  onReply?: (content: string) => void,
  onProposal?: (proposal: DevCharacterConversationProposal) => void,
): AssistantTransport {
  const thread: AssistantThreadSummary = {
    id: 'dev-character-conversation',
    title: 'Character conversation',
    isResolved: false,
    messageCount: 0,
  };
  const messages: AssistantMessage[] = [];
  const message = (
    role: AssistantMessage['role'],
    content: string,
    id: string,
  ): AssistantMessage => ({
    id,
    threadId: thread.id,
    role,
    content,
    createdAt: new Date().toISOString(),
  });
  return {
    listThreads: async () => [{ ...thread, messageCount: messages.length }],
    loadMessages: async () => [...messages],
    sendMessage: async (
      input: AssistantSendMessageInput,
    ): Promise<AssistantSendMessageResult> => {
      const user = message('user', input.content, input.clientRequestId);
      const context = [
        ...messages.filter((entry) => entry.id !== user.id),
        user,
      ]
        .map(({ role, content }) => ({ role, content }))
        .slice(-DEV_CHARACTER_MAX_MESSAGES);
      const serialize = () =>
        JSON.stringify({ messages: context, model: input.model });
      while (
        new TextEncoder().encode(serialize()).byteLength >
          DEV_CHARACTER_MAX_REQUEST_BYTES &&
        context.length > 1
      )
        context.shift();
      if (
        new TextEncoder().encode(serialize()).byteLength >
        DEV_CHARACTER_MAX_REQUEST_BYTES
      )
        throw new Error('Your message is too long. Please shorten it.');
      const response = await request('/api/dev-character-conversation', {
        method: 'POST',
        signal: input.signal,
        headers: { 'content-type': 'application/json' },
        body: serialize(),
      });
      const body = (await response.json().catch(() => ({}))) as {
        content?: unknown;
        proposal?: DevCharacterConversationProposal;
        warning?: unknown;
      };
      if (!response.ok || typeof body.content !== 'string')
        throw new Error(
          typeof body.warning === 'string'
            ? body.warning
            : 'The development assistant could not reply.',
        );
      const assistant = message(
        'assistant',
        body.content,
        `${input.clientRequestId}:reply`,
      );
      const previous = messages.findIndex((entry) => entry.id === user.id);
      if (previous >= 0) messages.splice(previous, 1);
      messages.push(user, assistant);
      onReply?.(assistant.content);
      if (body.proposal) onProposal?.(body.proposal);
      return {
        inProgress: false,
        userMessage: user,
        assistantMessage: assistant,
        messages: [user, assistant],
      };
    },
  };
}
