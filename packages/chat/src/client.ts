/**
 * Browser client for smrt-chat's streaming chat route — the consume side of
 * the SSE contract `createChatStreamHandler` serves (see `chat-stream.ts`,
 * which owns the wire contract and exports the encode side).
 *
 * This module is BROWSER-SAFE and dependency-free: it must not import the
 * server runtime (models, services, tool loop) or any workspace package, so
 * a static site can ship it without dragging server code into the bundle. It
 * is exported under the dedicated `@happyvertical/smrt-chat/client` subpath.
 *
 *   POST {endpoint}
 *   Authorization: Bearer <sessionId>        (SMRT bearer = session id)
 *   Content-Type: application/json
 *   Body: { "messages": ChatClientMessage[], "session": SmrtChatSession? }
 *
 *   Response: text/event-stream, events as `data: <json>` lines:
 *     { "type": "token",   "text": "..." }
 *     { "type": "emotion", "name": "heart" }      (reserved; v1 engine forwards
 *                                                  the model's inline cue as tokens)
 *     { "type": "control", "command": {...} }     (#1921 host-page control lane;
 *                                                  parsed, no client hook yet)
 *     { "type": "done",    "message": ChatStreamMessage }
 *     { "type": "error",   "error": "..." }
 *   plus `: heartbeat` comment lines every ~15s, which clients must ignore.
 *
 * The server always terminates a turn with a `done` or `error` frame; a clean
 * close without one means an intermediary cut the stream (proxy idle timeout)
 * and is surfaced as an error rather than an empty success.
 *
 * The widget-facing types below are STRUCTURALLY identical to
 * `@happyvertical/animation`'s chat contract (`ChatBackend`, `ChatMessage`,
 * `ChatStreamHandlers`, `ChatSendHandle`), so an instance drops straight into
 * `createHappyChat({ backend })` without this package depending on the widget
 * library. `client.contract.ts` pins the other seam under `pnpm typecheck`:
 * every `ChatStreamEvent` the server can emit is assignable to
 * `ChatClientStreamFrame`.
 */

/** A rendered conversation message (the widget-side shape; all fields set). */
export interface ChatClientMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

/** Streaming callbacks for one assistant reply. */
export interface ChatClientStreamHandlers {
  /** A chunk of assistant text (may be words or partial words). */
  onToken(text: string): void;
  /** An expression cue for the character (e.g. 'heart', 'wink'). */
  onEmotion?(name: string): void;
  /** The reply is complete; `message` is the final assembled message. */
  onDone(message: ChatClientMessage): void;
  onError(error: unknown): void;
}

export interface ChatClientSendHandle {
  cancel(): void;
}

/**
 * A conversation backend. `send` receives the FULL message history (latest
 * user message last) and streams the assistant reply through `handlers`.
 */
export interface ChatClientBackend {
  send(
    messages: ChatClientMessage[],
    handlers: ChatClientStreamHandlers,
  ): ChatClientSendHandle;
}

/**
 * Conversation identity, mirroring `ChatStreamSession`
 * (`VoiceGatewayTurnMetadata`) so a server route can bind the turn to an
 * AgentSession/persona. Mirrored rather than imported to keep this module
 * free of server imports; `client.test.ts` asserts the shapes stay aligned.
 */
export interface SmrtChatSession {
  tenantId?: string;
  actorProfileId?: string;
  chatRoomId?: string;
  threadId?: string;
  agentSessionId?: string;
  personaId?: string;
  voiceSessionId?: string;
}

export interface SmrtChatBackendOptions {
  /** Full URL of the streaming chat route. */
  endpoint: string;
  /** SMRT bearer token (the session id). Omit for cookie/same-origin auth. */
  token?: string;
  /**
   * fetch credentials mode (the `RequestCredentials` union, spelled out so
   * this module typechecks without the DOM lib). Cookie auth from a
   * cross-origin embed needs 'include' (pairs with the server's allow-listed
   * credentialed CORS, smrt #1861); the default is fetch's own 'same-origin'.
   */
  credentials?: 'omit' | 'same-origin' | 'include';
  /** Conversation identity (persona/agent-session binding). */
  session?: SmrtChatSession;
  fetchImpl?: typeof fetch;
}

/**
 * One parsed wire frame. Deliberately lenient where the client can degrade
 * (optional `message`/`error`) — and provably a superset of the server's
 * `ChatStreamEvent` union (compile-time lock in `client.test.ts`).
 */
export type ChatClientStreamFrame =
  | { type: 'token'; text: string }
  | { type: 'emotion'; name: string }
  | { type: 'control'; command: unknown }
  | {
      type: 'done';
      message?: {
        id?: string;
        role: ChatClientMessage['role'];
        content: string;
        createdAt?: string;
      };
    }
  | { type: 'error'; error?: string };

let counter = 0;

/** Message id: crypto.randomUUID when available, counter fallback. */
function messageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  counter += 1;
  return `msg-${Date.now()}-${counter}`;
}

/**
 * Pull `[emotion:name]` cues out of a reply, returning the clean text and the
 * last cue seen. The v1 streaming engine forwards the model's inline cue as
 * plain token text rather than an `emotion` frame, so the done message can
 * still carry it; strip it here so it never lands in the bubble/history, and
 * surface the emotion so the character still emotes.
 */
function extractEmotion(text: string): {
  clean: string;
  emotion: string | null;
} {
  let emotion: string | null = null;
  const clean = text
    .replace(/\s*\[emotion:(\w+)\]/g, (_, name: string) => {
      emotion = name;
      return '';
    })
    .trim();
  return { clean, emotion };
}

/**
 * Final message handed to `onDone`: keep the server's persisted identity
 * (id/createdAt) when present so a consumer reconciling with fetched room
 * history can match it, and fill honestly when the wire omitted it — the
 * wire shape has optional id/createdAt, the widget shape does not.
 */
function finalizeMessage(
  message: Extract<ChatClientStreamFrame, { type: 'done' }>['message'],
  content: string,
): ChatClientMessage {
  return {
    id: message?.id ?? messageId(),
    role: message?.role ?? 'assistant',
    content,
    createdAt: message?.createdAt ?? new Date().toISOString(),
  };
}

/**
 * SSE client for the streaming chat route (smrt-chat #1936). Structurally
 * implements `@happyvertical/animation`'s `ChatBackend`, so it plugs straight
 * into the floating chat widget.
 */
export class SmrtChatBackend implements ChatClientBackend {
  private options: SmrtChatBackendOptions;

  constructor(options: SmrtChatBackendOptions) {
    this.options = options;
  }

  send(
    messages: ChatClientMessage[],
    handlers: ChatClientStreamHandlers,
  ): ChatClientSendHandle {
    const controller = new AbortController();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.options.token) {
      headers.authorization = `Bearer ${this.options.token}`;
    }

    (async () => {
      const response = await fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers,
        credentials: this.options.credentials,
        body: JSON.stringify({
          messages,
          session: this.options.session,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        // The handler renders structured errors ({error, code}) — carry the
        // body so auth failures are distinguishable from bad requests.
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 200);
        } catch {
          /* body unreadable — status alone will have to do */
        }
        throw new Error(
          `[smrt-chat] chat endpoint responded ${response.status}${
            detail ? `: ${detail}` : ''
          }`,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue; // blank + `: heartbeat`
          const event = JSON.parse(line.slice(5)) as ChatClientStreamFrame;
          if (event.type === 'token' && event.text) {
            assembled += event.text;
            handlers.onToken(event.text);
          } else if (event.type === 'emotion' && event.name) {
            handlers.onEmotion?.(event.name);
          } else if (event.type === 'control') {
            // #1921 host-page control lane — recognized so the union stays
            // honest; no client hook yet (the widget executes controls via
            // its own registry when that wiring lands).
          } else if (event.type === 'error') {
            handlers.onError(
              new Error(event.error ?? '[smrt-chat] chat stream error'),
            );
            // The turn is settled but the server may keep sending (heartbeats,
            // late frames) — release the connection instead of leaving the
            // stream open until GC.
            reader.cancel().catch(() => {
              /* stream already closed — nothing to release */
            });
            return;
          } else if (event.type === 'done') {
            const raw = event.message?.content ?? assembled;
            const { clean, emotion } = extractEmotion(raw);
            if (emotion) handlers.onEmotion?.(emotion);
            handlers.onDone(finalizeMessage(event.message, clean));
            reader.cancel().catch(() => {
              /* stream already closed — nothing to release */
            });
            return;
          }
        }
      }
      // The server always terminates with done or error; a clean close
      // without one means an intermediary cut the stream. Never fabricate
      // a successful (possibly empty) reply out of a truncation.
      throw new Error('[smrt-chat] chat stream ended without a done frame');
    })().catch((error) => {
      if (!controller.signal.aborted) handlers.onError(error);
    });

    return { cancel: () => controller.abort() };
  }
}
