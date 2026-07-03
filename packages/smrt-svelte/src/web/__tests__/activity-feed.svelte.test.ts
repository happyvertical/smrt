/**
 * Unit tests for the AdminShell activity feed adapter's reconciliation core
 * (#1779).
 *
 * These exercise {@link ActivityFeedReconciler} — the pure diff between a set of
 * live rows and the shell activity registry — against a REAL {@link ShellState}.
 * Per repo policy nothing here is mocked: the shell, its activity events, and
 * the mapping are all real; the reconciler is fed plain row arrays that stand in
 * for successive live-collection ticks (`liveCollection`'s engine is exercised
 * separately in `activity-feed.integration.svelte.test.ts`). This isolates the
 * mapping / create-update-remove / ownership behavior the adapter guarantees.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createShellState } from '../../components/workspace/admin-shell/state.svelte.js';
import type {
  ShellActivityEvent,
  ShellState,
} from '../../components/workspace/index.js';
import {
  ActivityFeedReconciler,
  type ShellActivityInput,
} from '../activity-feed.svelte.js';

/** A row DTO for a background render job — the feed's backing collection shape. */
interface JobRow {
  id: string;
  title: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  progress?: number;
  draft?: boolean;
}

/** Editorial map: a job row → focus-scope activity, or `null` for a draft. */
const mapJob = (row: JobRow): ShellActivityInput | null => {
  if (row.draft) return null;
  return {
    kind: 'render-job',
    scope: 'focus',
    label: row.title,
    status: row.state,
    progress: row.progress ?? null,
  };
};

/** Record every activity event the shell emits, for sequence assertions. */
function recordEvents(shell: ShellState): {
  events: ShellActivityEvent[];
  stop: () => void;
} {
  const events: ShellActivityEvent[] = [];
  const stop = shell.watchActivities((event) => events.push(event));
  return { events, stop };
}

describe('ActivityFeedReconciler', () => {
  const teardown: Array<() => void> = [];

  afterEach(() => {
    for (const fn of teardown.splice(0)) fn();
  });

  function setup() {
    const shell = createShellState();
    const recorded = recordEvents(shell);
    teardown.push(recorded.stop);
    const reconciler = new ActivityFeedReconciler<JobRow>(shell, mapJob);
    return { shell, reconciler, events: recorded.events };
  }

  it('upserts a shell activity when a row first appears', () => {
    const { shell, reconciler, events } = setup();

    reconciler.reconcile([
      { id: 'job-1', title: 'Render intro', state: 'running', progress: 20 },
    ]);

    const activities = shell.listActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: 'job-1',
      kind: 'render-job',
      scope: 'focus',
      label: 'Render intro',
      status: 'running',
      progress: 20,
    });
    // The activity id defaults to the row id, and the shell stamped createdAt.
    expect(activities[0].createdAt).toBeTruthy();
    // A single create event (upsert), no transition/remove.
    expect(events.map((e) => e.type)).toEqual(['upsert']);
  });

  it('updates the activity in place when a row changes (status transition)', () => {
    const { shell, reconciler, events } = setup();

    reconciler.reconcile([
      { id: 'job-1', title: 'Render intro', state: 'running', progress: 20 },
    ]);
    const createdAt = shell.listActivities()[0].createdAt;

    // Same row id, advanced progress + status flip → an UPDATE, not a second
    // create, and the shell reports it as a `transition` (status changed).
    reconciler.reconcile([
      { id: 'job-1', title: 'Render intro', state: 'completed', progress: 100 },
    ]);

    const activities = shell.listActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: 'job-1',
      status: 'completed',
      progress: 100,
    });
    // createdAt preserved across the update (update went through updateActivity,
    // not a fresh upsert that would re-stamp it).
    expect(activities[0].createdAt).toBe(createdAt);
    expect(events.map((e) => e.type)).toEqual(['upsert', 'transition']);
  });

  it('performs no shell mutation when a reconcile tick is unchanged', () => {
    const { reconciler, events } = setup();

    const rows: JobRow[] = [
      { id: 'job-1', title: 'Render intro', state: 'running', progress: 20 },
    ];
    reconciler.reconcile(rows);
    // Re-feed identical content (a common no-op reactive tick): a new array with
    // an equal-but-distinct row object. Must not emit a second event.
    reconciler.reconcile([{ ...rows[0] }]);

    expect(events.map((e) => e.type)).toEqual(['upsert']);
  });

  it('removes the activity when its row vanishes from the collection', () => {
    const { shell, reconciler, events } = setup();

    reconciler.reconcile([
      { id: 'job-1', title: 'Render intro', state: 'running' },
      { id: 'job-2', title: 'Render outro', state: 'queued' },
    ]);
    expect(shell.listActivities()).toHaveLength(2);

    // job-1 gone from the next tick → removed; job-2 unchanged → left alone.
    reconciler.reconcile([
      { id: 'job-2', title: 'Render outro', state: 'queued' },
    ]);

    const remaining = shell.listActivities();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('job-2');
    expect(events.map((e) => e.type)).toEqual([
      'upsert', // job-1 create
      'upsert', // job-2 create
      'remove', // job-1 removed
    ]);
  });

  it('treats a row that maps to null as absent (excluded, then removed when it flips)', () => {
    const { shell, reconciler } = setup();

    // A draft row maps to null → never becomes an activity.
    reconciler.reconcile([
      { id: 'job-1', title: 'Draft', state: 'queued', draft: true },
    ]);
    expect(shell.listActivities()).toHaveLength(0);

    // It leaves draft → now an activity appears.
    reconciler.reconcile([
      { id: 'job-1', title: 'Published', state: 'running' },
    ]);
    expect(shell.listActivities()).toHaveLength(1);

    // It goes back to draft (maps to null again) → activity is removed.
    reconciler.reconcile([
      { id: 'job-1', title: 'Published', state: 'running', draft: true },
    ]);
    expect(shell.listActivities()).toHaveLength(0);
  });

  it('lets the map decouple the activity id from the row id', () => {
    const shell = createShellState();
    const reconciler = new ActivityFeedReconciler<JobRow>(shell, (row) => ({
      id: `activity:${row.id}`,
      kind: 'render-job',
      scope: 'system',
      label: row.title,
      status: row.state,
    }));

    reconciler.reconcile([{ id: 'job-1', title: 'Job', state: 'running' }]);

    const activities = shell.listActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0].id).toBe('activity:job-1');
  });

  it('routes an activity to the shell edge for its scope', () => {
    const { shell, reconciler } = setup();

    reconciler.reconcile([{ id: 'job-1', title: 'Job', state: 'running' }]);

    // scope 'focus' homes to the right edge (SCOPE_EDGES.focus === 'right').
    expect(shell.listActivities({ edge: 'right' })).toHaveLength(1);
  });

  it('re-homes the activity to the new edge when its scope changes (no explicit edge)', () => {
    const shell = createShellState();
    // Map keys scope off the row so a later tick can change it; no `edge` set.
    const reconciler = new ActivityFeedReconciler<JobRow>(shell, (row) => ({
      kind: 'render-job',
      // Reuse the unused `draft` flag as a cheap "move to system scope" toggle.
      scope: row.draft ? 'system' : 'focus',
      label: row.title,
      status: row.state,
    }));

    reconciler.reconcile([{ id: 'job-1', title: 'Job', state: 'running' }]);
    // Focus → right edge.
    expect(shell.listActivities({ edge: 'right' })).toHaveLength(1);
    expect(shell.listActivities({ edge: 'bottom' })).toHaveLength(0);

    // Scope flips to system; the map still sets no explicit edge. The activity
    // must RE-DERIVE its edge from the new scope (system → bottom), not stay
    // pinned to the old right edge.
    reconciler.reconcile([
      { id: 'job-1', title: 'Job', state: 'running', draft: true },
    ]);
    expect(shell.listActivities({ edge: 'right' })).toHaveLength(0);
    expect(shell.listActivities({ edge: 'bottom' })).toHaveLength(1);
    expect(shell.listActivities()[0].scope).toBe('system');
  });

  it('clears a previously-set optional field when a later mapping drops it', () => {
    const shell = createShellState();
    // Map emits `message`/`detailHref` only while the job is running.
    const reconciler = new ActivityFeedReconciler<JobRow>(shell, (row) => ({
      kind: 'render-job',
      scope: 'focus',
      label: row.title,
      status: row.state,
      ...(row.state === 'running'
        ? { message: 'Rendering frames', detailHref: '/jobs/job-1' }
        : {}),
    }));

    reconciler.reconcile([{ id: 'job-1', title: 'Job', state: 'running' }]);
    let activity = shell.listActivities()[0];
    expect(activity.message).toBe('Rendering frames');
    expect(activity.detailHref).toBe('/jobs/job-1');

    // The job completes → the map no longer emits message/detailHref. Those
    // stale values must be CLEARED, not retained from the previous mapping.
    reconciler.reconcile([{ id: 'job-1', title: 'Job', state: 'completed' }]);
    activity = shell.listActivities()[0];
    expect(activity.status).toBe('completed');
    expect(activity.message).toBeUndefined();
    expect(activity.detailHref).toBeUndefined();
  });

  it('dispose() removes exactly the feed activities and stops reconciling', () => {
    const { shell, reconciler, events } = setup();

    // An activity from ANOTHER source the feed must never touch.
    shell.upsertActivity({
      id: 'external-1',
      label: 'External',
      kind: 'other',
      scope: 'app',
      status: 'running',
    });
    reconciler.reconcile([
      { id: 'job-1', title: 'Render intro', state: 'running' },
    ]);
    expect(shell.listActivities()).toHaveLength(2);

    reconciler.dispose();

    // Only the feed's own activity was retracted; the external one survives.
    const remaining = shell.listActivities();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('external-1');
    expect(reconciler.isDisposed).toBe(true);

    // Reconciling after dispose is a no-op (no new activities, no events).
    const eventsBefore = events.length;
    reconciler.reconcile([
      { id: 'job-2', title: 'Late job', state: 'running' },
    ]);
    expect(shell.listActivities()).toHaveLength(1);
    expect(events.length).toBe(eventsBefore);
  });
});
