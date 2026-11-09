// Live updates: which load dependencies an `/api/events` event invalidates,
// parsing, and the reconnect schedule. The browser store is `live.svelte.ts`.
import type { ShellEvent } from './types.ts';

/** `depends()` keys used by the shell's load functions. */
export const DEPENDS = {
  shell: 'smrt:shell',
  records: 'smrt:records',
  approvals: 'smrt:approvals',
  history: 'smrt:history',
} as const;

export type DependsKey = (typeof DEPENDS)[keyof typeof DEPENDS];

const STATUSES = ['pending', 'approved', 'denied', 'failed'];

/** Parse an `event: shell` payload; anything unexpected is dropped. */
export function parseShellEvent(data: string): ShellEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (e.type === 'changed')
    return {
      type: 'changed',
      version: Number(e.version) || 0,
      summary: String(e.summary ?? ''),
    };
  if (e.type === 'records')
    return {
      type: 'records',
      model: typeof e.model === 'string' ? e.model : null,
    };
  if (e.type === 'approval' && typeof e.id === 'string')
    return {
      type: 'approval',
      id: e.id,
      status: (STATUSES.includes(String(e.status))
        ? e.status
        : 'pending') as 'pending',
      summary: String(e.summary ?? ''),
    };
  return null;
}

/** What to reload for one event. */
export function keysFor(event: ShellEvent): DependsKey[] {
  switch (event.type) {
    case 'changed':
      // The definition changed: menu, lists, forms, approvals and history.
      return [
        DEPENDS.shell,
        DEPENDS.records,
        DEPENDS.approvals,
        DEPENDS.history,
      ];
    case 'records':
      return [DEPENDS.records];
    case 'approval':
      // The menu badge lives in the shell data.
      return [DEPENDS.shell, DEPENDS.approvals];
  }
}

export const ALL_KEYS: DependsKey[] = Object.values(DEPENDS);

/** Fold a burst of events into one set of keys to reload. */
export function reduceKeys(
  pending: ReadonlySet<DependsKey>,
  event: ShellEvent,
): Set<DependsKey> {
  return new Set([...pending, ...keysFor(event)]);
}

/** A short line for screen readers, or null when nothing needs saying. */
export function announcement(event: ShellEvent): string | null {
  if (event.type === 'changed')
    return event.summary ? `App changed: ${event.summary}` : 'App changed';
  if (event.type === 'approval') {
    if (event.status === 'pending') return `Needs approval: ${event.summary}`;
    return `Approval ${event.status}: ${event.summary}`;
  }
  return null;
}

/** Reconnect delay in ms: exponential, capped, with jitter in [0.5, 1). */
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
  base = 1000,
  cap = 30_000,
): number {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(raw * (0.5 + random() / 2));
}
