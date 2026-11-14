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

/** Host-ordered history without timestamp provenance. Never synthesize occurredAt. */
export interface UndatedHistoryEntry
  extends Omit<AuditHistoryEntry, 'occurredAt' | 'profileId'> {
  occurredAt?: never;
  profileId?: string;
}
export type RecordHistoryEntry = AuditHistoryEntry | UndatedHistoryEntry;

export interface AuditListFilter {
  profileId: string;
  resourceId: string;
  from: string;
  to: string;
}

/** Resolves presentation text for one already-authorized audit entry. */
export type AuditEntryLabel<
  Entry extends RecordHistoryEntry = AuditHistoryEntry,
> = (entry: Entry) => string;

/**
 * Resolves an already-authorized destination for an audit entry.
 *
 * The component accepts local paths and explicit HTTP(S) URLs only. Consumers
 * must still authorize the referenced resource before exposing its href.
 */
export type AuditResourceHref<
  Entry extends RecordHistoryEntry = AuditHistoryEntry,
> = (entry: Entry) => string | null | undefined;

/** Resolves a presentation label for one changed field. */
export type AuditFieldLabel<
  Entry extends RecordHistoryEntry = AuditHistoryEntry,
> = (field: string, entry: Entry) => string;

export interface AuditValueFormatContext<
  Entry extends RecordHistoryEntry = AuditHistoryEntry,
> {
  entry: Entry;
  field: string;
  side: 'before' | 'after';
}

/** Formats an audit value as text. Formatter output is never rendered as HTML. */
export type AuditValueFormatter<
  Entry extends RecordHistoryEntry = AuditHistoryEntry,
> = (value: unknown, context: AuditValueFormatContext<Entry>) => string;
