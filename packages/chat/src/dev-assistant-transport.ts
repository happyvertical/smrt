import type { DevCharacterConversationProposal } from './routes/api/dev-character-conversation/protocol.js';
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
      messages.push(user);
      const response = await request('/api/dev-character-conversation', {
        method: 'POST',
        signal: input.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: messages.map(({ role, content }) => ({ role, content })),
          model: input.model,
        }),
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
      messages.push(assistant);
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
