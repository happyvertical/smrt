import type { ChatModel } from '../assistant/transport.ts';

/*
 * A small OpenAI-compatible chat client for the browser.
 *
 * `@happyvertical/ai` was checked first: its root entry wraps the `openai`,
 * Anthropic and AWS SDKs (Node-first, heavy, no browser-key guard), and its
 * browser-safe `./local` entry only has the WebLLM provider. Neither is a fit
 * for a visitor's own endpoint, so this is one `fetch` to
 * `${baseUrl}/chat/completions`.
 *
 * The key is only ever the Authorization header of a request to `baseUrl`. It
 * is never in a URL, a body, an error message or a log line.
 */

/** How hard to ask the endpoint for JSON, strictest first. */
export type JsonMode = 'json_schema' | 'json_object' | 'none';

const JSON_MODES: readonly JsonMode[] = ['json_schema', 'json_object', 'none'];

export interface OpenAIChatOptions {
  /** e.g. `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer`; omit for a local server. */
  apiKey?: string;
  /** Strictest JSON mode to try first; it steps down when the endpoint refuses it. */
  jsonMode?: JsonMode;
  fetch?: typeof fetch;
  /** Called with the mode that worked, so a caller can remember it. */
  onJsonMode?: (mode: JsonMode) => void;
}

const REQUEST_TIMEOUT_MS = 120_000;

/** `http(s)` base without a trailing slash, or null. */
export function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Credentials in a URL would travel in the clear as part of it.
    if (url.username || url.password) return null;
    for (const name of url.searchParams.keys()) {
      if (
        /^(?:api[-_]?key|key|token|authorization|secret|password)$/i.test(name)
      ) {
        return null;
      }
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Hosts that are this computer: a key may travel to them over plain http. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Can a key be sent to this address? `https`, or `http` to this computer only. */
export function keyMaySendTo(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopbackHost(url.hostname))
    );
  } catch {
    return false;
  }
}

/** The origin a key was entered for: scheme, host and port of the address. */
export function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).origin;
  } catch {
    return null;
  }
}

/** A failure that says what happened and never carries the key. */
export class EndpointError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EndpointError';
  }
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `the endpoint refused the key (${status})`;
  }
  if (status === 404) {
    return 'the endpoint or model was not found (404), check the address and model name';
  }
  if (status === 429) return 'the endpoint is rate limiting you (429)';
  return `the endpoint answered ${status}`;
}

/** The text of the first choice, or a reason there is none. */
function textOf(payload: unknown): string {
  const choice = (
    payload as { choices?: { message?: { content?: unknown } }[] }
  )?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  throw new EndpointError('the endpoint sent no reply text');
}

function responseFormat(
  mode: JsonMode,
  schema: Record<string, unknown> | string | undefined,
) {
  if (mode === 'none') return undefined;
  if (mode === 'json_schema' && schema && typeof schema === 'object') {
    return {
      type: 'json_schema',
      json_schema: { name: 'planner_turn', strict: false, schema },
    };
  }
  return { type: 'json_object' };
}

export interface CompleteOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  /** Ask for JSON-mode output (default true). */
  json?: boolean;
  temperature?: number;
  schema?: Record<string, unknown> | string;
}

export interface OpenAIChat extends ChatModel {
  complete(
    messages: { role: string; content: string }[],
    extra?: CompleteOptions,
  ): Promise<string>;
}

/**
 * A `ChatModel` over `${baseUrl}/chat/completions`. JSON-mode output is asked
 * for with the planner's schema; an endpoint that answers 400/422 to it (many
 * local servers know only `json_object`, some nothing) is retried one step
 * down, and the step that worked is kept for the rest of the session.
 */
export function createOpenAIChat(options: OpenAIChatOptions): OpenAIChat {
  const base = normalizeBaseUrl(options.baseUrl);
  if (!base) throw new EndpointError('the address is not a valid http(s) URL');
  if (options.apiKey && !keyMaySendTo(base)) {
    throw new EndpointError(
      'a key is only sent over https, or to this computer; use an https address',
    );
  }
  const url = `${base}/chat/completions`;
  const doFetch = options.fetch ?? fetch;
  let level = Math.max(
    0,
    JSON_MODES.indexOf(options.jsonMode ?? 'json_schema'),
  );

  async function post(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        // No cookies for a third-party endpoint.
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // A blocked cross-origin call and an unreachable server look the same
      // to a page: a TypeError with no detail.
      throw new EndpointError(
        'could not reach the endpoint. Is it running, and does it allow this page (CORS)?',
      );
    }
  }

  async function complete(
    messages: { role: string; content: string }[],
    extra: CompleteOptions = {},
  ): Promise<string> {
    const wantJson = extra.json !== false;
    for (;;) {
      const mode = wantJson ? (JSON_MODES[level] ?? 'none') : 'none';
      const format = responseFormat(mode, extra.schema);
      const response = await post(
        {
          model: options.model,
          messages,
          stream: false,
          temperature: extra.temperature ?? 0,
          ...(extra.maxTokens ? { max_tokens: extra.maxTokens } : {}),
          ...(format ? { response_format: format } : {}),
        },
        extra.signal,
      );
      if (response.ok) {
        if (wantJson) options.onJsonMode?.(mode);
        return textOf(await response.json().catch(() => null));
      }
      // The endpoint refused the JSON mode: step down and ask again.
      if (
        wantJson &&
        (response.status === 400 || response.status === 422) &&
        level < JSON_MODES.length - 1
      ) {
        level += 1;
        continue;
      }
      throw new EndpointError(describeStatus(response.status), response.status);
    }
  }

  return {
    complete,
    message(text, callOptions) {
      return complete(
        [
          ...(callOptions?.history ?? []).map(({ role, content }) => ({
            role,
            content,
          })),
          { role: 'user', content: text },
        ],
        {
          maxTokens: callOptions?.maxTokens,
          signal: callOptions?.signal,
          temperature: callOptions?.temperature,
          schema: callOptions?.responseSchema,
        },
      );
    },
  };
}

export interface ConnectionResult {
  ok: boolean;
  /** One sentence for the visitor. */
  message: string;
}

/**
 * Test connection: one tiny completion, so the address, the model and the key
 * are all exercised. Never throws and never echoes the key.
 */
export async function testConnection(
  options: OpenAIChatOptions,
): Promise<ConnectionResult> {
  try {
    const chat = createOpenAIChat({ ...options, jsonMode: 'none' });
    const reply = await chat.complete(
      [{ role: 'user', content: 'Reply with the single word OK.' }],
      { maxTokens: 8, json: false },
    );
    return {
      ok: true,
      message: reply.trim()
        ? `Connected to ${options.model}.`
        : `Connected to ${options.model}, but it sent an empty reply.`,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof EndpointError
          ? `Could not connect: ${error.message}.`
          : 'Could not connect.',
    };
  }
}
