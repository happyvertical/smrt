import type { ChatModel } from '../assistant/transport.ts';
import type { PlanSnapshot } from '../planner/commands/types.ts';

/** Wire contract version; see `docs/inference-host.md`. */
export const HOST_WIRE_VERSION = 1;
/** Recent turns sent along (the transport already keeps six). */
export const HOST_HISTORY_TURNS = 6;
/** Longest history entry sent; the rest is cut. */
export const HOST_HISTORY_CHARS = 1000;
/** Longest message sent. */
export const HOST_MESSAGE_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 60_000;

/** What the planner POSTs to the host endpoint. */
export interface HostRequest {
  version: typeof HOST_WIRE_VERSION;
  /** The visitor's text, and nothing else of the prompt. */
  message: string;
  /** The compact plan snapshot from the controller. */
  snapshot: PlanSnapshot;
  /** Bounded recent turns, oldest first. Never a system message. */
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface HostChatOptions {
  /** `http(s)://…` or a path on the page's own origin. */
  endpoint: string;
  /** The plan as it is now, read per turn. */
  snapshot: () => PlanSnapshot;
  fetch?: typeof fetch;
  /** Extra request headers a host wants (a CSRF token, say). */
  headers?: () => Record<string, string>;
}

const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) : text;

/**
 * A `ChatModel` that asks the host's server. The server owns the prompt: only
 * the visitor's text, the compact snapshot and bounded recent turns leave the
 * page. The system prompt the transport builds for local models is dropped,
 * as is the response schema; the server answers with the same action JSON
 * the assistant reads from a model (see `docs/inference-host.md`).
 */
export function createHostChat(options: HostChatOptions): ChatModel {
  const doFetch = options.fetch ?? fetch;
  return {
    async message(text, callOptions) {
      const history = (callOptions?.history ?? [])
        .filter(
          (turn): turn is { role: 'user' | 'assistant'; content: string } =>
            turn.role === 'user' || turn.role === 'assistant',
        )
        .slice(-HOST_HISTORY_TURNS)
        .map((turn) => ({
          role: turn.role,
          content: clip(turn.content, HOST_HISTORY_CHARS),
        }));
      const body: HostRequest = {
        version: HOST_WIRE_VERSION,
        message: clip(text, HOST_MESSAGE_CHARS),
        snapshot: options.snapshot(),
        ...(history.length ? { history } : {}),
      };
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = callOptions?.signal
        ? AbortSignal.any([callOptions.signal, timeout])
        : timeout;
      const response = await doFetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...options.headers?.(),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new Error(`the server answered ${response.status}`);
      }
      const reply = await response.text();
      // The body is the action object. Plain text is read as the reply itself.
      return reply;
    },
  };
}
