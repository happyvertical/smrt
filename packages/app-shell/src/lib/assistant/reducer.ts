// The dock's state as a pure reducer: the thread, the streaming reply,
// tool-call chips and approval cards. No DOM, no fetch.
import type {
  AssistantStatus,
  ThreadMessage,
  TurnEvent,
  TurnStop,
} from './events.ts';

export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'failed'
  | 'timeout';

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      state: 'running' | 'ok' | 'error';
      summary: string;
    }
  | {
      kind: 'approval';
      id: string;
      approvalId: string;
      summary: string;
      preview: unknown;
      state: ApprovalState;
      busy: boolean;
      message: string;
      /** Left over from an earlier turn (the turn that asked is gone). */
      detached: boolean;
    }
  | {
      kind: 'note';
      id: string;
      tone: 'error' | 'info';
      text: string;
      /** A fix for the problem ("Sign in again"), when there is one. */
      action?: { label: string; href: string };
    };

export interface DockState {
  threadId: string | null;
  items: Item[];
  running: boolean;
  stop: TurnStop | null;
  /** `unknown` until the first status answer. */
  availability: 'unknown' | 'ready' | 'unavailable';
  unavailableMessage: string;
  /** Where to fix an unavailable assistant (a link in the dock), if anywhere. */
  unavailableAction: { label: string; href: string } | null;
  /** Plain-text name of the engine in effect, for the dock's caption. */
  engineLabel: string;
  seq: number;
}

export const initialState: DockState = {
  threadId: null,
  items: [],
  running: false,
  stop: null,
  availability: 'unknown',
  unavailableMessage: '',
  unavailableAction: null,
  engineLabel: '',
  seq: 0,
};

export type Action =
  | { type: 'status'; status: AssistantStatus }
  | { type: 'send'; text: string }
  | { type: 'event'; event: TurnEvent }
  | { type: 'loaded'; threadId: string; messages: ThreadMessage[] }
  | { type: 'reset' }
  | {
      type: 'pending_approvals';
      approvals: { id: string; summary: string; preview: unknown }[];
    }
  | { type: 'approval_busy'; approvalId: string; busy: boolean }
  | {
      type: 'approval_result';
      approvalId: string;
      state: ApprovalState | null;
      message: string;
    }
  | { type: 'note'; tone: 'error' | 'info'; text: string }
  | {
      type: 'unavailable';
      message: string;
      action?: { label: string; href: string };
    }
  | { type: 'ended' };

const next = (s: DockState, prefix: string) => `${prefix}${s.seq + 1}`;

function closeStreaming(items: Item[]): Item[] {
  return items.map((i) =>
    i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i,
  );
}

function patch(
  items: Item[],
  match: (i: Item) => boolean,
  change: (i: Item) => Item,
): Item[] {
  return items.map((i) => (match(i) ? change(i) : i));
}

export function reduce(state: DockState, action: Action): DockState {
  switch (action.type) {
    case 'status':
      return action.status.configured
        ? {
            ...state,
            availability: 'ready',
            unavailableMessage: '',
            unavailableAction: null,
            engineLabel: action.status.engineLabel ?? '',
          }
        : {
            ...state,
            availability: 'unavailable',
            unavailableMessage:
              action.status.message ?? 'The assistant is not available.',
            unavailableAction: action.status.action ?? null,
            // Never claim an engine is "in use" when it cannot answer.
            engineLabel: '',
          };
    case 'unavailable':
      return {
        ...state,
        running: false,
        availability: 'unavailable',
        unavailableMessage: action.message,
        unavailableAction: action.action ?? state.unavailableAction,
        items: state.items.filter(
          (i) => !(i.kind === 'user' && i.id === `u${state.seq}`),
        ),
      };
    case 'send':
      return {
        ...state,
        running: true,
        stop: null,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          { kind: 'user', id: `u${state.seq + 1}`, text: action.text },
        ],
      };
    case 'reset':
      return {
        ...initialState,
        availability: state.availability,
        unavailableMessage: state.unavailableMessage,
        unavailableAction: state.unavailableAction,
        engineLabel: state.engineLabel,
        seq: state.seq,
      };
    case 'ended':
      return {
        ...state,
        running: false,
        items: closeStreaming(state.items),
      };
    case 'note':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...state.items,
          {
            kind: 'note',
            id: next(state, 'n'),
            tone: action.tone,
            text: action.text,
          },
        ],
      };
    case 'loaded': {
      let seq = state.seq;
      const items: Item[] = [];
      for (const m of action.messages) {
        seq += 1;
        if (m.role === 'user')
          items.push({ kind: 'user', id: `m${seq}`, text: m.content });
        else if (m.role === 'assistant')
          items.push({
            kind: 'assistant',
            id: `m${seq}`,
            text: m.content,
            streaming: false,
          });
        else if (m.tool)
          items.push({
            kind: 'tool',
            id: `m${seq}`,
            name: m.tool.name,
            state: m.tool.ok ? 'ok' : 'error',
            summary: m.tool.summary,
          });
      }
      return {
        ...state,
        threadId: action.threadId,
        items,
        seq,
        running: false,
        stop: null,
      };
    }
    case 'pending_approvals': {
      const have = new Set(
        state.items.flatMap((i) =>
          i.kind === 'approval' ? [i.approvalId] : [],
        ),
      );
      let seq = state.seq;
      const added: Item[] = [];
      for (const a of action.approvals) {
        if (have.has(a.id)) continue;
        seq += 1;
        added.push({
          kind: 'approval',
          id: `a${seq}`,
          approvalId: a.id,
          summary: a.summary,
          preview: a.preview,
          state: 'pending',
          busy: false,
          message: '',
          detached: true,
        });
      }
      return added.length
        ? { ...state, seq, items: [...state.items, ...added] }
        : state;
    }
    case 'approval_busy':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'approval' && i.approvalId === action.approvalId,
          (i) => ({
            ...(i as Extract<Item, { kind: 'approval' }>),
            busy: action.busy,
            message: '',
          }),
        ),
      };
    case 'approval_result':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'approval' && i.approvalId === action.approvalId,
          (i) => {
            const a = i as Extract<Item, { kind: 'approval' }>;
            return {
              ...a,
              busy: false,
              message: action.message,
              state: action.state ?? a.state,
            };
          },
        ),
      };
    case 'event':
      return onEvent(state, action.event);
  }
}

function onEvent(state: DockState, e: TurnEvent): DockState {
  switch (e.type) {
    case 'thread':
      return { ...state, threadId: e.threadId };
    case 'text': {
      const last = state.items.at(-1);
      if (last?.kind === 'assistant' && last.streaming)
        return {
          ...state,
          items: [
            ...state.items.slice(0, -1),
            { ...last, text: last.text + e.delta },
          ],
        };
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id: next(state, 'r'),
            text: e.delta,
            streaming: true,
          },
        ],
      };
    }
    case 'tool_call':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          {
            kind: 'tool',
            id: `t:${e.id}`,
            name: e.name,
            state: 'running',
            summary: '',
          },
        ],
      };
    case 'tool_result':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'tool' && i.id === `t:${e.id}`,
          (i) => ({
            ...(i as Extract<Item, { kind: 'tool' }>),
            state: e.ok ? 'ok' : 'error',
            summary: e.summary,
          }),
        ),
      };
    case 'approval_required':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items).filter(
            (i) => !(i.kind === 'approval' && i.approvalId === e.approvalId),
          ),
          {
            kind: 'approval',
            id: `a:${e.id}`,
            approvalId: e.approvalId,
            summary: e.summary,
            preview: e.preview,
            state: 'pending',
            busy: false,
            message: '',
            detached: false,
          },
        ],
      };
    case 'approval_decided':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'approval' && i.approvalId === e.approvalId,
          (i) => ({
            ...(i as Extract<Item, { kind: 'approval' }>),
            state: e.status,
            busy: false,
            message: '',
          }),
        ),
      };
    case 'error':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          {
            kind: 'note',
            id: next(state, 'n'),
            tone: 'error',
            text: e.message,
            ...(e.action ? { action: e.action } : {}),
          },
        ],
      };
    case 'done':
      return {
        ...state,
        running: false,
        stop: e.stop,
        items: closeStreaming(state.items),
      };
  }
}

/** A short label for a tool chip: `chore_create` -> `Chore create`. */
export function toolLabel(name: string): string {
  const words = name.replace(/^app_/, '').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** What to tell the person when a turn ended early. */
export function stopNote(stop: TurnStop | null): string {
  switch (stop) {
    case 'max_steps':
    case 'max_tokens':
      return 'I stopped to keep things short. Ask me to continue if you want more.';
    case 'timeout':
      return 'That took too long, so I stopped.';
    case 'waiting':
      return 'Waiting for your decision. Nothing has changed yet.';
    case 'aborted':
      return 'Stopped.';
    default:
      return '';
  }
}

/**
 * What the screen-reader live region says. Never the reply itself: the reply
 * is already in the log, and repeating its text there made every answer appear
 * twice (once in the log, once in the hidden live region) to text extraction
 * and to a screen reader.
 */
export function announcement(state: DockState): string {
  if (state.running) return 'The assistant is working.';
  return state.items.at(-1)?.kind === 'assistant'
    ? 'The assistant replied.'
    : '';
}
