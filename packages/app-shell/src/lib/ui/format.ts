// Small display helpers.

/** "3 minutes ago" style text; falls back to a date for old or bad input. */
export function timeAgo(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 14) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

export function fullTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Versions newest first. */
export function newestFirst<T extends { version: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.version - a.version);
}

export interface OwnerProfile {
  id: string;
  name?: string | null;
}

/** Human attribution for this single-owner shell, without exposing user ids. */
export function authorName(
  author: string,
  owner?: OwnerProfile | null,
): string {
  if (!author) return '';
  if (author === 'engine') return 'engine';
  if (author === 'assistant') return 'the assistant';
  if (author === owner?.id) return owner.name?.trim() || 'the owner';
  return 'the owner';
}
