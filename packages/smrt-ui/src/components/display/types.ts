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

/** Text overrides for `DocumentViewer`; defaults come from the `ui` i18n catalog. */
export interface DocumentViewerLabels {
  region: string;
  pages: string;
  zoom: string;
  previousPage: string;
  nextPage: string;
  /** Template with `{page}` and `{pages}`. */
  pageOf: string;
  /** Template with `{label}` and `{page}`; names the PDF page canvas. */
  pageLabel: string;
  zoomOut: string;
  zoomIn: string;
  fit: string;
  loading: string;
  failed: string;
  retry: string;
  unsupported: string;
}
