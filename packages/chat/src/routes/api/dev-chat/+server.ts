import type { AIMessage, ChatOptions } from '@happyvertical/ai';
import { json, type RequestHandler } from '@sveltejs/kit';
import { chatUnavailableBody } from '../../../ai-unavailable.js';
import {
  type DevAIConfig,
  devAIClientOptions,
  resolveDevAIConfig,
} from '../dev-ai.js';

const MAX_MESSAGES = 24;
const MAX_CONTENT_LENGTH = 8_000;
const DEFAULT_MAX_TOKENS = 700;

type DevChatMode = 'ai' | 'local';

interface DevChatRequest {
  messages?: Array<{
    role?: unknown;
    content?: unknown;
  }>;
  model?: unknown;
  temperature?: unknown;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeMessages(messages: DevChatRequest['messages']): AIMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.slice(-MAX_MESSAGES).flatMap((message): AIMessage[] => {
    const role = message.role;
    if (
      role !== 'system' &&
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'tool' &&
      role !== 'function'
    ) {
      return [];
    }

    const content = nonEmpty(message.content);
    if (!content) {
      return [];
    }

    return [
      {
        role,
        content: content.slice(0, MAX_CONTENT_LENGTH),
      },
    ];
  });
}

function latestUserMessage(messages: AIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }

  return '';
}

function localReply(messages: AIMessage[]): string {
  const latest = latestUserMessage(messages);
  const trimmed =
    latest.length > 180 ? `${latest.slice(0, 177).trimEnd()}...` : latest;

  if (!trimmed) {
    return 'Local dev chat is ready.';
  }

  return `Local dev reply received: "${trimmed}"`;
}

function buildChatOptions(
  aiConfig: DevAIConfig,
  body: DevChatRequest,
): ChatOptions {
  const options: ChatOptions = {
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
  };

  if (aiConfig.model) {
    options.model = aiConfig.model;
  }

  return options;
}

async function runAIChat(
  aiConfig: DevAIConfig,
  messages: AIMessage[],
  body: DevChatRequest,
): Promise<{ content: string; model?: string }> {
  const { getAI } = await import('@happyvertical/ai');
  const options = await devAIClientOptions(aiConfig);
  const ai = await getAI(options as never);
  const model =
    typeof options.model === 'string' ? options.model : aiConfig.model;
  const response = await ai.chat(
    messages,
    buildChatOptions({ ...aiConfig, model }, body),
  );

  return {
    content: response.content || localReply(messages),
    model: response.model || model,
  };
}

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as DevChatRequest;
  const messages = normalizeMessages(body.messages);
  const requestedModel = nonEmpty(body.model);
  const aiConfig = resolveDevAIConfig(requestedModel);
  const seededMessages: AIMessage[] = [
    {
      role: 'system',
      content:
        'You are the local @happyvertical/smrt-chat dev assistant. Keep replies concise and useful for testing chat UI behavior.',
    },
    ...messages,
  ];

  if (!messages.some((message) => message.role === 'user')) {
    return json(
      {
        mode: 'local' satisfies DevChatMode,
        content: localReply(messages),
        configured: Boolean(aiConfig),
      },
      { status: 400 },
    );
  }

  if (aiConfig) {
    try {
      const result = await runAIChat(aiConfig, seededMessages, body);
      return json({
        mode: 'ai' satisfies DevChatMode,
        provider: aiConfig.provider,
        model: result.model,
        content: result.content,
        configured: true,
      });
    } catch (error) {
      // AI off (#4757): a structured answer, not the local fallback.
      const unavailable = chatUnavailableBody(error);
      if (unavailable) return json(unavailable, { status: 503 });
      return json({
        mode: 'local' satisfies DevChatMode,
        provider: aiConfig.provider,
        model: aiConfig.model,
        content: localReply(messages),
        configured: true,
        warning:
          error instanceof Error
            ? `AI request failed: ${error.message}`
            : 'AI request failed.',
      });
    }
  }

  return json({
    mode: 'local' satisfies DevChatMode,
    content: localReply(messages),
    configured: false,
  });
};
