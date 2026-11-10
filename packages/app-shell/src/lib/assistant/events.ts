// The wire contract of an assistant turn, shared by the server (which sends
// it as server-sent events) and the dock (which reduces it). Pure types and
// helpers: no server or browser imports.

/** Why a turn ended. `waiting` = left an approval undecided. */
export type TurnStop =
  | 'complete'
  | 'max_steps'
  | 'max_tokens'
  | 'timeout'
  | 'aborted'
  | 'waiting'
  | 'error';

export type TurnEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
    }
  | {
      type: 'approval_required';
      id: string;
      name: string;
      approvalId: string;
      summary: string;
      preview: unknown;
    }
  | {
      type: 'approval_decided';
      id: string;
      approvalId: string;
      status: 'approved' | 'denied' | 'failed' | 'timeout';
    }
  | {
      type: 'error';
      code: string;
      message: string;
      /** Where to fix it ("Sign in again"), when there is somewhere. */
      action?: { label: string; href: string };
    }
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
export type AssistantEngineId = (typeof ASSISTANT_ENGINES)[number];

/** `GET /api/assistant/status`. Never carries a key, provider or endpoint. */
export interface AssistantStatus {
  configured: boolean;
  /** The engine in effect. */
  engine?: AssistantEngineId;
  /** Plain-text name of that engine for the dock (`Claude Code`, `an API key`). */
  engineLabel?: string;
  /**
   * Set when not configured: `assistant_not_configured`, `ai_unavailable`,
   * `agent_cli_missing`, `agent_cli_signed_out` or `chatgpt_signed_out`.
   */
  code?: string;
  message?: string;
  /** Where to fix it, when there is somewhere. */
  action?: { label: string; href: string };
}

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
  };
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}
