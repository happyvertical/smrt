// Live updates: which load dependencies an `/api/events` event invalidates,
// parsing, and the reconnect schedule. The browser store is `live.svelte.ts`.
import { isApplySummary, plural } from './changes.ts';
import type { ShellEvent } from './types.ts';

/** `depends()` keys used by the shell's load functions. */
export const DEPENDS = {
  shell: 'smrt:shell',
  records: 'smrt:records',
  approvals: 'smrt:approvals',
  history: 'smrt:history',
  changes: 'smrt:changes',
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
  const target =
    e.target === 'draft' || e.target === 'live' ? e.target : undefined;
  if (e.type === 'changed')
    return {
      type: 'changed',
      ...(target ? { target } : {}),
      version: Number(e.version) || 0,
      summary: String(e.summary ?? ''),
    };
  if (e.type === 'records')
    return {
      type: 'records',
      ...(target ? { target } : {}),
      model: typeof e.model === 'string' ? e.model : null,
    };
  if (e.type === 'limit' && ['cap', 'route', 'period'].includes(String(e.kind)))
    return {
      type: 'limit',
      kind: e.kind as 'cap',
      message: String(e.message ?? '').slice(0, 500),
    };
  if (
    e.type === 'draft' &&
    typeof e.id === 'string' &&
    ['started', 'published', 'discarded', 'unpublishable'].includes(
      String(e.status),
    )
  )
    return {
      type: 'draft',
      status: e.status as 'started',
      id: e.id,
      name: String(e.name ?? ''),
    };
  if (
    e.type === 'changes' &&
    ['changed', 'applied', 'discarded', 'undone'].includes(String(e.status))
  )
    return {
      type: 'changes',
      status: e.status as 'changed',
      batchId: String(e.batchId ?? ''),
      count: Number(e.count) || 0,
      generation: Number(e.generation) || 0,
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
        // Apply's `undoDigest` follows the live version.
        DEPENDS.changes,
      ];
    case 'records':
      return [DEPENDS.records];
    case 'limit':
      // The notice is in the layout's data.
      return [DEPENDS.shell];
    case 'approval':
      // The menu badge lives in the shell data.
      return [DEPENDS.shell, DEPENDS.approvals];
    case 'draft':
      // The private working copy moved: everything is stale.
      return [...ALL_KEYS];
    case 'changes':
      // The count, and History's Undo; applied or undone changes the app too.
      return event.status === 'applied' || event.status === 'undone'
        ? [...ALL_KEYS]
        : [DEPENDS.changes, DEPENDS.history];
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
  // The private working copy is never owner-facing.
  if (event.type === 'draft') return null;
  if (event.type === 'changes') {
    if (event.status === 'applied') return 'Applied. Your app is live.';
    if (event.status === 'undone') return 'Undone. Your app is as it was.';
    if (event.status === 'discarded') return 'Changes discarded.';
    return event.count > 0 ? `${plural(event.count, 'change')} waiting` : null;
  }
  if (event.type === 'limit') return event.message;
  if (event.type === 'approval') {
    // The owner's own Apply says "Applied" already.
    if (isApplySummary(event.summary)) return null;
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
