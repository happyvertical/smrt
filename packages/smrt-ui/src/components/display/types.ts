/**
 * Display component types
 */

export type StatusType =
  | 'default'
  | 'invoice'
  | 'project'
  | 'expense'
  | 'time'
  | 'compliance'
  | 'estimate';

/** Semantic tone for custom status vocabulary. */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
