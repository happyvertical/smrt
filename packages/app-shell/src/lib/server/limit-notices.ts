// Notices to the app owner when a per-app cap, the plan's request cap or a route
// limit refuses a request (#5198). The refused caller is often not the owner (a
// guest, an API client), so the refusal the caller sees never reaches the
// owner's screen; the host records it here and the shell shows it.
//
// In memory, per process: a notice is a heads-up, not a record (the counts live
// in the usage metrics, `readTenantUsage().requests.refused`). It is lost on a
// restart and not shared between replicas; the owner who is told once can look
// at Settings, and a cap that keeps refusing says so again at once.
import type { LimitNotice } from '../../engine/index.ts';
import { publish } from './events.ts';

/** What the owner is shown for one kind of refusal. */
export interface OwnerLimitNotice extends LimitNotice {
  /** How many requests were refused since the owner last dismissed it. */
  count: number;
  /** ISO time of the latest refusal. */
  lastAt: string;
}

const MAX_TENANTS = 10_000;
/** Most kinds of notice held per tenant. */
const MAX_PER_TENANT = 8;
/** A notice nobody read for this long is dropped. */
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE = 500;

const held = new Map<string, Map<string, OwnerLimitNotice & { at: number }>>();

/** The key a tenant's notices are kept under: the desktop has one owner, `''`. */
export function noticeKey(tenantId: string | null | undefined): string {
  return tenantId ?? '';
}

/** Record one refusal for the tenant's owner and tell their open screens. */
export function recordLimitNotice(
  tenantId: string | null | undefined,
  notice: LimitNotice,
  now: () => number = Date.now,
): void {
  try {
    const key = noticeKey(tenantId);
    const at = now();
    let mine = held.get(key);
    if (mine) held.delete(key);
    else mine = new Map();
    held.set(key, mine); // most recently used last
    while (held.size > MAX_TENANTS) {
      const oldest = held.keys().next().value;
      if (oldest === undefined) break;
      held.delete(oldest);
    }
    const kind = `${notice.kind}:${notice.cap ?? ''}`;
    const had = mine.get(kind);
    mine.delete(kind);
    mine.set(kind, {
      kind: notice.kind,
      ...(notice.cap ? { cap: notice.cap } : {}),
      message: notice.message.slice(0, MAX_MESSAGE),
      count: (had?.count ?? 0) + 1,
      lastAt: new Date(at).toISOString(),
      at,
    });
    while (mine.size > MAX_PER_TENANT) {
      const oldest = mine.keys().next().value;
      if (oldest === undefined) break;
      mine.delete(oldest);
    }
    publish(
      { type: 'limit', kind: notice.kind, message: notice.message },
      tenantId ?? null,
    );
  } catch {
    // A notice never fails the request that caused it.
  }
}

/** The tenant's notices, latest first; the old ones are dropped. */
export function readLimitNotices(
  tenantId: string | null | undefined,
  now: () => number = Date.now,
): OwnerLimitNotice[] {
  const mine = held.get(noticeKey(tenantId));
  if (!mine) return [];
  const t = now();
  for (const [kind, n] of mine) if (t - n.at > TTL_MS) mine.delete(kind);
  return [...mine.values()].reverse().map(({ at: _at, ...notice }) => notice);
}

/** The owner has seen them. */
export function dismissLimitNotices(tenantId: string | null | undefined): void {
  held.delete(noticeKey(tenantId));
}

/** Tests: forget every notice. */
export function resetLimitNotices(): void {
  held.clear();
}
