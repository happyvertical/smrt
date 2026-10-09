/** Authorized activity projected by an owning domain package. */
export interface ActivityListEntry {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  href?: string | null;
}
