/**
 * Generic "something is working" status rendered by `WorkingStrip`.
 *
 * - `idle`: nothing is shown;
 * - `working`: a spinner and what is happening ("Writing the summary…");
 * - `done`: a short confirmation ("Done · 2 changes") the host clears after
 *   a few seconds.
 *
 * Transport-neutral: an assistant turn, an upload, or a background job can
 * all feed it.
 */
export interface WorkingStatus {
  /** Lifecycle phase. */
  phase: 'idle' | 'working' | 'done';
  /** What to say; `null` falls back to "Working…" / "Done". */
  label: string | null;
}
