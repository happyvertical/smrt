import { getContext, setContext } from 'svelte';

/** Static standard outcomes and engagement; never includes component data. */
export type StandardAnalyticsEvent =
  | 'planner_opened'
  | 'planner_cookbook_applied'
  | 'project_question_answered'
  | 'project_decision_resolved'
  | 'project_preview_opened'
  | 'project_preview_approved'
  | 'project_preview_rejected';
/** Optional private receipt identity, used only for in-memory duplicate suppression. */
export interface AnalyticsEmissionOptions {
  dedupeKey?: string;
}
export type AnalyticsSink = (
  name: string,
  options?: AnalyticsEmissionOptions,
) => unknown;
const KEY = Symbol.for('@happyvertical/smrt-ui/analytics');
const noop: AnalyticsSink = () => {};

/** Install once during the host root component's initialization. No SSR globals. */
export function setAnalyticsContext(sink: AnalyticsSink): void {
  setContext(KEY, sink);
}
/** Capture during component initialization; absent configuration is a noop. */
export function getAnalyticsContext(): AnalyticsSink {
  const sink = getContext<AnalyticsSink | undefined>(KEY) ?? noop;
  return (name, options) => {
    try {
      Promise.resolve(sink(name, options)).catch(() => {});
    } catch {
      /* analytics never breaks UI */
    }
  };
}

/** Observe only persisted status changes; initial/historical rows are not events. */
export function createAnalyticsTransitions(
  emit: (name: StandardAnalyticsEvent) => unknown,
) {
  const seen = new Map<string, string>();
  return (
    rows: readonly { id: string; status: string }[],
    from: string,
    outcomes: Readonly<Record<string, StandardAnalyticsEvent>>,
  ) => {
    const present = new Set(rows.map((row) => row.id));
    for (const id of seen.keys()) {
      if (!present.has(id)) seen.delete(id);
    }
    for (const row of rows) {
      const previous = seen.get(row.id);
      seen.set(row.id, row.status);
      const outcome = outcomes[row.status];
      if (previous === from && outcome) {
        try {
          Promise.resolve(emit(outcome)).catch(() => {});
        } catch {
          /* no UI failures */
        }
      }
    }
  };
}
