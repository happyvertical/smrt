/** Semantic tone for an activity status pill. */
export type ActivityStatusTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error';

/** Context badge (for example a project or workspace chip) shown on an activity row. */
export interface ActivityContextBadge {
  label: string;
  href?: string | null;
}

/** Structured status badge shown on an activity row. */
export interface ActivityStatusBadge {
  label: string;
  tone?: ActivityStatusTone;
}

/** Authorized activity projected by an owning domain package or application. */
export interface ActivityListEntry {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  href?: string | null;
  source?: string;
  sourceLabel?: string;
  code?: string;
  context?: ActivityContextBadge | null;
  status?: ActivityStatusBadge | null;
  meta?: string;
  dismissed?: boolean;
}

/** Optional interactive triage and dismissal controls accepted by `ActivityList` and `ActivityWidgetData`. */
export interface ActivityListControls {
  /** Message displayed when no activity entries exist. */
  emptyLabel?: string;
  /** Message displayed when all unread entries have been dismissed. */
  caughtUpLabel?: string;
  /** Force source filter pills on (`true`) or off (`false`); defaults to automatic when 2+ sources exist. */
  sourceFilter?: boolean;
  /** Callback invoked to dismiss a single activity entry by id. */
  onDismiss?: (id: string) => void | Promise<void>;
  /** Callback invoked to dismiss all currently visible unread entries. */
  onDismissMany?: (ids: string[]) => void | Promise<void>;
  /** Callback invoked to restore a previously dismissed entry by id. */
  onRestore?: (id: string) => void | Promise<void>;
  /** Whether the last dismissal action can be undone. */
  canUndo?: boolean;
  /** Callback invoked when the user activates Undo. */
  onUndo?: () => void | Promise<void>;
  /** Total count of dismissed entries when managed externally by the host. */
  dismissedCount?: number;
  /** Whether dismissed entries are currently visible. */
  showDismissed?: boolean;
  /** Callback invoked to toggle visibility of dismissed entries. */
  onToggleShowDismissed?: () => void;
  /** Reference clock epoch in milliseconds for deterministic relative timestamp rendering across SSR and hydration. */
  now?: number;
  /** IANA time zone for timestamp tooltips and absolute fallbacks (defaults to `'UTC'` so SSR and browser agree). */
  timeZone?: string;
  /** Optional BCP-47 locale tag override for timestamp formatting. */
  locale?: string;
}

/** Props accepted by `ActivityList`. */
export interface ActivityListProps extends ActivityListControls {
  /** Already-authorized activity rows to display. */
  entries: ActivityListEntry[];
}
