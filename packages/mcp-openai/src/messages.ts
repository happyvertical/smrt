import type { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { type OpenAiContextText, openAiContextText } from './context.js';
import { json, keys, record, text } from './validation.js';

export const OPENAI_MESSAGE_CAPABILITY = 'openai/message';
export type OpenAiMessageTarget = 'active' | 'new';

export interface OpenAiMessage {
  text: OpenAiContextText;
  target?: OpenAiMessageTarget;
}

export function hasOpenAiMessage(rawCapabilities: unknown): boolean {
  try {
    json(rawCapabilities);
    const capabilities = record(rawCapabilities);
    const experimental = capabilities.experimental;
    return (
      experimental !== undefined &&
      record(experimental)[OPENAI_MESSAGE_CAPABILITY] !== undefined &&
      record(record(experimental)[OPENAI_MESSAGE_CAPABILITY]) !== undefined
    );
  } catch {
    return false;
  }
}

/** Pinned `ui/message` payload. Mobile-compatible callers omit target (active). */
export function openAiMessage(value: OpenAiMessage): Record<string, unknown> {
  json(value);
  const input = record(value);
  keys(input, ['text', 'target']);
  const target = input.target === undefined ? 'active' : input.target;
  if (target !== 'active' && target !== 'new')
    throw new TypeError('Unsupported message target');
  return {
    role: 'user',
    content: [openAiContextText(input.text as OpenAiContextText)],
    ...(target === 'active'
      ? {}
      : { _meta: { 'openai/message': { target: 'new', send: true } } }),
  };
}

/** Native send when explicitly negotiated; otherwise retain the portable text message. */
export async function sendOpenAiMessage(options: {
  bridge: McpAppBridge;
  value: OpenAiMessage;
  native?(params: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}): Promise<'native' | 'portable'> {
  const params = openAiMessage(options.value);
  if (
    options.native &&
    hasOpenAiMessage(options.bridge.snapshot.rawHostCapabilities)
  ) {
    await options.native(params, options.signal);
    return 'native';
  }
  if (options.value.target === 'new') {
    throw new TypeError('New-conversation messages require native support');
  }
  await options.bridge.sendMessage(
    text(options.value.text.text, 16384),
    options.signal,
  );
  return 'portable';
}
