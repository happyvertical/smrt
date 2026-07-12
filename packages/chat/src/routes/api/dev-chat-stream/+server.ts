/**
 * Dev-only token-streaming chat endpoint (#1936) — the SSE companion to
 * `/api/dev-chat`. Wires the reusable `createChatStreamHandler` in PLAIN
 * (unbound) mode: it uses `@happyvertical/ai` when local provider credentials
 * are present and falls back to a deterministic local streamer otherwise, so the
 * package-local workbench (and an embedded `SmrtChatBackend` client pointed at
 * it) can exercise streaming end-to-end without a persona/session.
 *
 * This is a workbench surface, not the production contract: real deployments
 * wire `createChatStreamHandler` with their own `authorize` (validating the
 * caller and resolving a persona-bound `ChatStreamContext`).
 */

import type { AIInterface, AIMessage } from '@happyvertical/ai';
import type { RequestHandler } from '@sveltejs/kit';
import {
  type ChatStreamContext,
  createChatStreamHandler,
} from '../../../chat-stream.js';

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function env(name: string): string | undefined {
  return nonEmpty(process.env[name]);
}

interface DevAIConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function resolveDevAIConfig(): DevAIConfig | null {
  const explicitProvider =
    env('SMRT_CHAT_DEV_PROVIDER') ||
    env('SMRT_AI_PROVIDER') ||
    env('HAVE_AI_PROVIDER');
  const provider =
    explicitProvider ||
    (env('OPENAI_API_KEY')
      ? 'openai'
      : env('ANTHROPIC_API_KEY')
        ? 'anthropic'
        : env('GEMINI_API_KEY')
          ? 'gemini'
          : undefined);
  if (!provider) return null;

  const normalized = provider.toLowerCase();
  const apiKey =
    env('SMRT_CHAT_DEV_API_KEY') ||
    env('SMRT_AI_API_KEY') ||
    env('HAVE_AI_API_KEY') ||
    (normalized === 'anthropic'
      ? env('ANTHROPIC_API_KEY')
      : normalized === 'gemini'
        ? env('GEMINI_API_KEY')
        : normalized === 'openai'
          ? env('OPENAI_API_KEY')
          : undefined);

  return {
    provider,
    apiKey,
    baseUrl:
      env('SMRT_CHAT_DEV_BASE_URL') ||
      env('SMRT_AI_BASE_URL') ||
      env('HAVE_AI_BASE_URL'),
    model:
      env('SMRT_CHAT_DEV_MODEL') ||
      env('SMRT_AI_MODEL') ||
      env('HAVE_AI_MODEL'),
  };
}

function lastUserMessage(messages: AIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

/**
 * A deterministic local streaming AI for the no-credentials path: echoes the
 * user's message back in word-sized chunks so the SSE token lane is exercised.
 */
function localStreamAI(): AIInterface {
  return {
    async *stream(messages: AIMessage[]) {
      const latest = lastUserMessage(messages);
      const reply = latest
        ? `Local dev stream received: "${latest.slice(0, 180)}"`
        : 'Local dev chat stream is ready.';
      for (const word of reply.split(/(\s+)/)) {
        if (word) yield word;
      }
    },
  } as unknown as AIInterface;
}

async function resolveAI(): Promise<AIInterface> {
  const config = resolveDevAIConfig();
  if (!config) return localStreamAI();
  try {
    const { getAI } = await import('@happyvertical/ai');
    return (await getAI({
      type: config.provider,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model,
    } as never)) as AIInterface;
  } catch {
    return localStreamAI();
  }
}

const handler = createChatStreamHandler({
  authorize: async (): Promise<ChatStreamContext> => ({
    ai: await resolveAI(),
    systemPrompt:
      'You are the local @happyvertical/smrt-chat dev streaming assistant. ' +
      'Keep replies concise and useful for testing streamed chat UI behavior.',
    maxTokens: 700,
    temperature: 0.4,
  }),
});

export const POST: RequestHandler = ({ request }) => handler(request);
