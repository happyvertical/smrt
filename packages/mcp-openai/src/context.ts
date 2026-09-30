import type { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { json, keys, record, text } from './validation.js';

export const OPENAI_MODEL_CONTEXT_CAPABILITY = 'openai/modelContext';

export interface OpenAiIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface OpenAiContextText {
  text: string;
  title?: string;
  thumbnail?: OpenAiIcon;
  /** Hidden from the person, never hidden from the model or provider. */
  background?: boolean;
}

export interface OpenAiModelContextUpdate {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
}

function icon(value: unknown): OpenAiIcon {
  json(value);
  const input = record(value);
  keys(input, ['src', 'mimeType', 'sizes', 'theme']);
  const result: OpenAiIcon = { src: text(input.src, 2048) };
  if (input.mimeType !== undefined) result.mimeType = text(input.mimeType, 128);
  if (input.sizes !== undefined) {
    if (!Array.isArray(input.sizes) || input.sizes.length > 8)
      throw new TypeError('Invalid icon sizes');
    result.sizes = input.sizes.map((size) => text(size, 32));
  }
  if (input.theme !== undefined) {
    if (input.theme !== 'light' && input.theme !== 'dark')
      throw new TypeError('Invalid icon theme');
    result.theme = input.theme;
  }
  return result;
}

/**
 * Builds only the pinned OpenAI extension fields. `_meta` crosses the provider
 * boundary, so `background` is a visibility choice and never a privacy grant.
 */
export function openAiContextText(
  value: OpenAiContextText,
): Record<string, unknown> {
  json(value);
  const input = record(value);
  keys(input, ['text', 'title', 'thumbnail', 'background']);
  const result: Record<string, unknown> = {
    type: 'text',
    text: text(input.text, 16384),
  };
  const meta: Record<string, unknown> = {};
  if (input.title !== undefined) meta['openai/title'] = text(input.title, 512);
  if (input.thumbnail !== undefined)
    meta['openai/thumbnail'] = icon(input.thumbnail);
  if (Object.keys(meta).length) result._meta = meta;
  if (input.background !== undefined) {
    if (typeof input.background !== 'boolean')
      throw new TypeError('Expected background boolean');
    if (input.background) result.annotations = { audience: ['assistant'] };
  }
  return result;
}

/** Validates a bounded, idempotent replacement for this app instance's context. */
export function openAiModelContextUpdate(value: {
  text?: OpenAiContextText;
  structuredContent?: Record<string, unknown>;
}): OpenAiModelContextUpdate {
  json(value);
  const input = record(value);
  keys(input, ['text', 'structuredContent']);
  if (input.text === undefined && input.structuredContent === undefined)
    throw new TypeError('Model context requires content or structuredContent');
  return {
    ...(input.text === undefined
      ? {}
      : { content: [openAiContextText(input.text as OpenAiContextText)] }),
    ...(input.structuredContent === undefined
      ? {}
      : { structuredContent: record(input.structuredContent) }),
  };
}

/** Capability detection is explicit; unknown/malformed data cannot enable native metadata. */
export function hasOpenAiModelContext(rawCapabilities: unknown): boolean {
  try {
    json(rawCapabilities);
    const capabilities = record(rawCapabilities);
    const experimental = capabilities.experimental;
    return (
      experimental !== undefined &&
      record(experimental)[OPENAI_MODEL_CONTEXT_CAPABILITY] !== undefined &&
      record(record(experimental)[OPENAI_MODEL_CONTEXT_CAPABILITY]) !==
        undefined
    );
  } catch {
    return false;
  }
}

/**
 * Sends a portable text/structured fallback through the existing bridge when
 * native support was not negotiated. Native callers receive the exact wire
 * payload and may transport title/thumbnail/background without leaking them
 * into portable public types.
 */
export async function updateOpenAiModelContext(options: {
  bridge: McpAppBridge;
  value: {
    text?: OpenAiContextText;
    structuredContent?: Record<string, unknown>;
  };
  native?(
    params: OpenAiModelContextUpdate,
    signal?: AbortSignal,
  ): Promise<void>;
  signal?: AbortSignal;
}): Promise<'native' | 'portable'> {
  const params = openAiModelContextUpdate(options.value);
  if (
    options.native &&
    hasOpenAiModelContext(options.bridge.snapshot.rawHostCapabilities)
  ) {
    await options.native(params, options.signal);
    return 'native';
  }
  await options.bridge.updateModelContext(
    {
      ...(options.value.text === undefined
        ? {}
        : { text: options.value.text.text }),
      ...(params.structuredContent === undefined
        ? {}
        : { structuredContent: params.structuredContent }),
    },
    options.signal,
  );
  return 'portable';
}
