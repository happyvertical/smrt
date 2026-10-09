/** Browser-safe projection. Supply only entries authorized by the server. */
export interface AuditHistoryEntry {
  id: string;
  profileId: string;
  actorLabel?: string;
  onBehalfOfId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  reason?: string;
  changes?: Record<string, { before: unknown; after: unknown }>;
}

export interface AuditListFilter {
  profileId: string;
  resourceId: string;
  from: string;
  to: string;
}

/** Resolves presentation text for one already-authorized audit entry. */
export type AuditEntryLabel = (entry: AuditHistoryEntry) => string;

/**
 * Resolves an already-authorized destination for an audit entry.
 *
 * The component accepts local paths and explicit HTTP(S) URLs only. Consumers
 * must still authorize the referenced resource before exposing its href.
 */
export type AuditResourceHref = (
  entry: AuditHistoryEntry,
) => string | null | undefined;

/** Resolves a presentation label for one changed field. */
export type AuditFieldLabel = (
  field: string,
  entry: AuditHistoryEntry,
) => string;

export interface AuditValueFormatContext {
  entry: AuditHistoryEntry;
  field: string;
  side: 'before' | 'after';
}

/** Formats an audit value as text. Formatter output is never rendered as HTML. */
export type AuditValueFormatter = (
  value: unknown,
  context: AuditValueFormatContext,
) => string;
