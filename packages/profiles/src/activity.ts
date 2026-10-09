import type { AuditLog } from './models/AuditLog.js';

/** Browser-safe activity DTO, structurally accepted by smrt-svelte's ActivityList. */
export interface AuditActivityEntry {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  href?: string | null;
}

export interface AuditActivityOptions {
  /** Optional app-authorized destination; never inferred from an audit resource. */
  href?: (entry: AuditLog) => string | null | undefined;
  /** App-supplied label for profile ids; audit data has no display name. */
  actorLabel?: (entry: AuditLog) => string | undefined;
}

/** Projects already-authorized audit records into safe, presentation-only activity rows. */
export function auditActivityEntries(
  entries: readonly AuditLog[],
  options: AuditActivityOptions = {},
): AuditActivityEntry[] {
  return entries
    .map((entry) => ({
      id: String(entry.id),
      title: `${options.actorLabel?.(entry) || entry.profileId || 'Unknown actor'} · ${entry.action}`,
      detail: entry.reason || `${entry.resourceType} / ${entry.resourceId}`,
      occurredAt: entry.occurredAt.toISOString(),
      href: options.href?.(entry) ?? null,
    }))
    .toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}
