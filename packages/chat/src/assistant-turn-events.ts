/**
 * Assistant turn wire contract (#2908): the events one streamed assistant
 * turn emits, the small generic status a host shell can show while it runs,
 * and the browser-side SSE reader.
 *
 * BROWSER-SAFE and dependency-free, like `client.ts`: the server engine
 * (`assistant-turn.ts`) imports the types from here, and the AssistantDock
 * (`svelte/components/assistant/`) imports the reader. Exported under
 * `@happyvertical/smrt-chat/assistant-turn`.
 *
 *   Response: text/event-stream, one `data: <json>` line per event:
 *     { "type": "status", "status": AssistantStatus }
 *     { "type": "token", "text": "..." }                 (live preview only)
 *     { "type": "step", "step": AssistantTurnStep }      ("calling X", "done")
 *     { "type": "message", "message": {...} }            (a persisted message)
 *     { "type": "client_tool_calls", "continuationId": "...", "calls": [...] }
 *     { "type": "done", "message": {...}?, "stoppedReason": "..." }
 *     { "type": "error", "error": "...", "code": "..." }
 *   plus `: heartbeat` comment lines, which readers ignore.
 *
 * A turn ends with exactly one of `done`, `error`, or `client_tool_calls`.
 * `client_tool_calls` suspends the turn: the browser runs the calls and
 * resumes it with their results under `continuationId`.
 */

/** The coarse state a host shows ("working strip", status line). */
export type AssistantStatusState = 'idle' | 'working' | 'done' | 'error';

/**
 * The generic assistant status: one plain-language line plus a state.
 * Emitted by the server engine as `status` events and derived by the dock
 * controller (`controller.status`, `onStatus`).
 */
export interface AssistantStatus {
  state: AssistantStatusState;
  /** Plain-language line ("Looking up articles…", "Done"), or null. */
  label: string | null;
  /** Changes the user applied during this piece of work (done state). */
  changes?: number;
  /** Whether the in-flight work can be stopped (`controller.cancel()`). */
  cancellable?: boolean;
}

/** Where a tool ran. */
export type AssistantToolLocation = 'server' | 'client';

/** A browser tool's declared effect (mirrors smrt-web's `WebMcpToolEffect`). */
export type AssistantToolEffect = 'read' | 'write' | 'destructive';

/** One progress step of a turn. */
export type AssistantTurnStep =
  | { kind: 'thinking'; step: number }
  | {
      kind: 'tool_call';
      callId: string;
      tool: string;
      label: string;
      location: AssistantToolLocation;
    }
  | {
      kind: 'tool_result';
      callId: string;
      tool: string;
      label: string;
      ok: boolean;
      error?: string;
    };

/** A browser tool call the server suspended on. */
export interface AssistantClientToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The effect the page declared; the dock re-reads it from its registry. */
  effect: AssistantToolEffect;
}

/** A browser tool declaration sent with a turn (untrusted on the server). */
export interface AssistantClientToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: AssistantToolEffect;
}

/** The browser's answer to one {@link AssistantClientToolCall}. */
export interface AssistantClientToolResult {
  id: string;
  ok: boolean;
  result?: string;
  /** `declined` when the user said no; otherwise a short reason. */
  error?: string;
}

/** Why a turn finished. */
export type AssistantTurnStopReason =
  | 'stop'
  | 'max_steps'
  | 'no_tools'
  | 'cancelled';

/** One event of a streamed assistant turn. `M` is the host's message shape. */
export type AssistantTurnEvent<M = Record<string, unknown>> =
  | { type: 'status'; status: AssistantStatus }
  | { type: 'token'; text: string }
  | { type: 'step'; step: AssistantTurnStep }
  | { type: 'message'; message: M }
  | {
      type: 'client_tool_calls';
      continuationId: string;
      calls: AssistantClientToolCall[];
    }
  | { type: 'done'; message?: M; stoppedReason: AssistantTurnStopReason }
  | {
      type: 'error';
      /**
       * A message safe to show the user: either a deliberate user-facing
       * message or a generic one. Server detail is logged, never sent.
       */
      error: string;
      /** A stable machine code (`internal_error` for an unexpected failure). */
      code?: string;
    };

/** Serialize one event as an SSE frame. */
export function encodeAssistantTurnEvent(
  event: AssistantTurnEvent<unknown>,
): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** The outcome of reading one streamed turn. */
export interface AssistantTurnStreamOutcome<M = Record<string, unknown>> {
  /** Every persisted message the turn reported (tool results, the reply). */
  messages: M[];
  /** The terminal `done` event, when the turn finished. */
  done?: Extract<AssistantTurnEvent<M>, { type: 'done' }>;
  /** The suspension, when the turn is waiting on browser tools. */
  clientToolCalls?: Extract<
    AssistantTurnEvent<M>,
    { type: 'client_tool_calls' }
  >;
}

/** Thrown by {@link readAssistantTurnStream} for an in-band `error` or a cut stream. */
export class AssistantTurnStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantTurnStreamError';
  }
}

function parseFrame<M>(data: string): AssistantTurnEvent<M> | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    return parsed && typeof parsed.type === 'string'
      ? (parsed as AssistantTurnEvent<M>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a streamed assistant turn from a `text/event-stream` response,
 * reporting each event to `onEvent` as it arrives.
 *
 * Resolves once a terminal event (`done` or `client_tool_calls`) arrives;
 * rejects with {@link AssistantTurnStreamError} on an in-band `error` or when
 * the stream closes without a terminal event (an intermediary cut it).
 * Tolerates heartbeat comments and frames split across chunks.
 */
export async function readAssistantTurnStream<M = Record<string, unknown>>(
  response: Response,
  onEvent?: (event: AssistantTurnEvent<M>) => void,
): Promise<AssistantTurnStreamOutcome<M>> {
  const body = response.body;
  if (!body) {
    throw new AssistantTurnStreamError('The assistant sent no response.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const outcome: AssistantTurnStreamOutcome<M> = { messages: [] };
  let buffer = '';

  const handle = (event: AssistantTurnEvent<M>): boolean => {
    try {
      onEvent?.(event);
    } catch {
      // A host callback never breaks the stream.
    }
    switch (event.type) {
      case 'message':
        outcome.messages.push(event.message);
        return false;
      case 'done':
        outcome.done = event;
        return true;
      case 'client_tool_calls':
        outcome.clientToolCalls = event;
        return true;
      case 'error':
        throw new AssistantTurnStreamError(
          event.error || 'The assistant failed.',
        );
      default:
        return false;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          const event = parseFrame<M>(data);
          if (event && handle(event)) return outcome;
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
  } finally {
    // Release the connection promptly once the turn has settled.
    void reader.cancel().catch(() => undefined);
  }
  throw new AssistantTurnStreamError(
    'The assistant stopped responding before finishing.',
  );
}

/** Tool allow-list matching (browser-safe), re-exported for hosts. */
export { matchesToolAllowList } from './tool-allow-list.js';
