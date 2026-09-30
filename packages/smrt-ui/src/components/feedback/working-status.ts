/**
 * Generic "something is working" status rendered by `WorkingStrip`.
 *
 * - `idle`: nothing is shown;
 * - `working`: a spinner and what is happening ("Writing the summary…");
 * - `paused`: the work is on hold until the person continues it;
 * - `waiting`: the work needs the person (a change to review, a choice to
 *   make, a question to answer) — shown prominently, announced assertively;
 * - `done`: a short confirmation ("Done · 2 changes") the host clears after
 *   a few seconds;
 * - `failed`: the work stopped on a problem — announced assertively;
 * - `cancelled`: the person stopped it.
 *
 * Transport-neutral: an assistant run, an upload, or a background job can
 * all feed it.
 */
export type WorkingPhase =
  | 'idle'
  | 'working'
  | 'paused'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface WorkingStatus {
  /** Lifecycle phase. */
  phase: WorkingPhase;
  /**
   * What to say: the current step while working ("Opening Events"), the
   * outcome otherwise. `null` falls back to a default for the phase.
   */
  label: string | null;
  /**
   * What the work is for, in the person's own words ("Show me upcoming
   * meetings"). Shown above the step on the floating pill; optional.
   */
  goal?: string | null;
}

/** Phases whose change is announced assertively (the person is needed). */
export const WORKING_ASSERTIVE_PHASES: readonly WorkingPhase[] = [
  'waiting',
  'failed',
];
