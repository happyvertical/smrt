// The wire contract shared by the server and dock. Imports are type-only;
// the browser does not load the inference server entry.
import type {
  AgentTurnEvent,
  AgentTurnStop,
  InferenceEngineAction,
  InferenceEngineId,
  InferenceEngineStatus,
} from '@happyvertical/smrt-inference/server';

/** API-key turns also stop at the host's model-round and token bounds. */
export type TurnStop = AgentTurnStop | 'max_steps' | 'max_tokens';

export type TurnEvent =
  | Exclude<AgentTurnEvent, { type: 'done' | 'tool_result' | 'error' }>
  | { type: 'thread'; threadId: string }
  | (Omit<Extract<AgentTurnEvent, { type: 'tool_result' }>, 'details'> & {
      /** The copy the shell's tool acted on, while a draft is open. */
      copy?: 'live' | 'draft';
    })
  | (Extract<AgentTurnEvent, { type: 'error' }> & {
      /** A host route that fixes the failure, when one exists. */
      action?: InferenceEngineAction;
    })
  | { type: 'done'; stop: TurnStop };

/**
 * Which engine runs the assistant: `api` (an API key through smrt-inference),
 * a local agent CLI (the person's own, signed-in `claude-code` / `codex`), or
 * `chatgpt` (the owner's own ChatGPT plan through Sign in with ChatGPT, a
 * preview for open source apps).
 */
export const ASSISTANT_ENGINES = [
  'api',
  'claude-code',
  'codex',
  'chatgpt',
] as const;
export type AssistantEngineId = InferenceEngineId;

/** `GET /api/assistant/status`. Never carries a key, provider or endpoint. */
export type AssistantStatus = InferenceEngineStatus;

/** Body of a 503 when the assistant cannot run (not a crash). */
export interface AssistantUnavailable extends AssistantStatus {
  type: 'unavailable';
  configured: false;
  code: string;
  error: string;
}

/** A stored message as the dock shows it. */
export interface ThreadMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool messages: what the chip shows. */
  tool?: {
    id: string;
    name: string;
    ok: boolean;
    summary: string;
    approvalId?: string;
    copy?: 'live' | 'draft';
  };
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}
