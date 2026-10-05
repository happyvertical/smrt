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
