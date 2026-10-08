/**
 * Fixed-tool model seam for the package-local character conversation demo.
 *
 * This route is development-only, loopback-only, and same-origin-only. It is
 * intentionally not a production authentication or app-control mechanism:
 * callers cannot select URLs, run JavaScript, provide provider credentials, or
 * apply a proposed browser action. The only result of a model tool call is a
 * typed proposal for the client to preview and explicitly confirm.
 */
import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import { error, isHttpError, json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { resolveDevAIConfig } from '../dev-ai.js';
import {
  DEV_CHARACTER_CONVERSATION_SECTIONS,
  type DevCharacterConversationProposal,
  type DevCharacterConversationResponse,
  type DevCharacterConversationSection,
} from './protocol.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MESSAGES = 24;
const MAX_CONTENT_LENGTH = 4_000;
const MAX_DRAFT_LENGTH = 500;

const tools: AITool[] = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Propose navigation to one known local development section.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['section'],
        properties: {
          section: {
            type: 'string',
            enum: DEV_CHARACTER_CONVERSATION_SECTIONS,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stageDraft',
      description: 'Propose text for the local development draft form.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: {
          value: { type: 'string', minLength: 1, maxLength: MAX_DRAFT_LENGTH },
        },
      },
    },
  },
];

interface ConversationRequest {
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '::1'
  );
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) error(400, 'Conversation request must be JSON.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        error(413, 'Conversation request is too large.');
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (request.signal.aborted) error(499, 'Conversation cancelled.');
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    error(400, 'Conversation request must be valid JSON.');
  }
}

function normalizeMessages(body: ConversationRequest): AIMessage[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.slice(-MAX_MESSAGES).flatMap((message): AIMessage[] => {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return [];
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    if (typeof message.content !== 'string') return [];
    const content = message.content.trim().slice(0, MAX_CONTENT_LENGTH);
    return content ? [{ role: message.role, content }] : [];
  });
}

function conversationBody(value: unknown): ConversationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    error(400, 'Conversation request must be an object.');
  return value as ConversationRequest;
}

function objectArguments(call: AIToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.function.arguments);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    error(422, 'The assistant proposed malformed tool arguments.');
  }
}

function onlyKeys(args: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(args).every((key) => keys.includes(key));
}

function proposalFromCall(call: AIToolCall): DevCharacterConversationProposal {
  const args = objectArguments(call);
  if (call.function.name === 'navigate') {
    const section = args.section;
    if (
      !onlyKeys(args, ['section']) ||
      typeof section !== 'string' ||
      !DEV_CHARACTER_CONVERSATION_SECTIONS.includes(
        section as (typeof DEV_CHARACTER_CONVERSATION_SECTIONS)[number],
      )
    ) {
      error(422, 'The assistant proposed an invalid local section.');
    }
    return {
      kind: 'navigate',
      section: section as DevCharacterConversationSection,
      preview: {
        title: 'Navigate in the dev workbench',
        description: `Open the ${section} section.`,
      },
    };
  }
  if (call.function.name === 'stageDraft') {
    const value = args.value;
    if (
      !onlyKeys(args, ['value']) ||
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > MAX_DRAFT_LENGTH
    ) {
      error(422, 'The assistant proposed an invalid draft.');
    }
    const draft = value.trim();
    return {
      kind: 'stageDraft',
      value: draft,
      preview: {
        title: 'Stage a draft subject',
        description: `Stage “${draft}” in the local draft form.`,
      },
    };
  }
  error(422, 'The assistant proposed an unsupported tool.');
}

export const POST: RequestHandler = async ({ request, url }) => {
  if (!dev || !isLoopback(url)) error(404, 'Not found.');
  if (!hasSameOrigin(request)) error(403, 'Forbidden.');
  if (request.signal.aborted) error(499, 'Conversation cancelled.');
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES)
    error(413, 'Conversation request is too large.');

  const body = conversationBody(await readBoundedJson(request));
  const messages = normalizeMessages(body);
  if (!messages.some((message) => message.role === 'user'))
    error(400, 'Conversation requires a user message.');

  const config = resolveDevAIConfig();
  if (!config)
    error(
      503,
      'Configure a server-side AI provider for character conversation.',
    );

  try {
    const { getAI } = await import('@happyvertical/ai');
    const ai = await getAI({
      type: config.provider,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model,
    } as never);
    const response = await ai.chat(
      [
        {
          role: 'system',
          content:
            'You are the local character conversation assistant. Keep spoken replies brief (500 characters or fewer), and never respond with silence or an acknowledgement alone. Use a tool only to propose a local section change or a draft subject. Never claim an action was applied; the user must confirm every proposal.',
        },
        ...messages,
      ],
      {
        model: config.model,
        maxTokens: 700,
        temperature: 0.3,
        tools,
        signal: request.signal,
      },
    );
    if (request.signal.aborted) error(499, 'Conversation cancelled.');
    const calls = response.toolCalls ?? [];
    if (calls.length > 1)
      error(422, 'The assistant must propose one action at a time.');
    const result: DevCharacterConversationResponse = {
      content: response.content || 'I have a proposal ready for your review.',
      ...(response.model || config.model
        ? { model: response.model ?? config.model }
        : {}),
      ...(calls[0] ? { proposal: proposalFromCall(calls[0]) } : {}),
    };
    return json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (request.signal.aborted) error(499, 'Conversation cancelled.');
    if (isHttpError(cause)) throw cause;
    error(502, 'Character conversation provider failed.');
  }
};
