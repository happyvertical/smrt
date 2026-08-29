/**
 * Realtime and background-workflow state for ContentList (#2455).
 *
 * The tracker is framework-free so the same instance can be used by a host's
 * action controls and by ContentList. It owns submission idempotency and job
 * transitions; the component only renders its snapshots and refreshes a query
 * when a successful job actually targets the visible page/query.
 */

export type ContentListJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export type ContentListJobTarget =
  | { kind: 'rows'; rowIds: readonly string[] }
  | { kind: 'query'; queryKey: string };

export interface ContentListJob {
  jobId: string;
  actionId: string;
  submissionKey: string;
  status: ContentListJobStatus;
  target: ContentListJobTarget;
  completed?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface ContentListJobSubmission {
  actionId: string;
  /** Stable key for one logical invocation. Duplicate active keys coalesce. */
  submissionKey: string;
  target: ContentListJobTarget;
}

export interface ContentListJobSnapshot {
  readonly jobs: readonly ContentListJob[];
  readonly pendingRowIds: ReadonlySet<string>;
  readonly pendingQueryKeys: ReadonlySet<string>;
}

export interface ContentListJobBinding {
  snapshot(): ContentListJobSnapshot;
  subscribe(listener: (snapshot: ContentListJobSnapshot) => void): () => void;
  /** True only when this failed attempt can start one explicit successor. */
  canRetry?(jobId: string): boolean;
  retry(jobId: string): Promise<ContentListJob>;
}

export interface ContentListJobController extends ContentListJobBinding {
  submit(
    submission: ContentListJobSubmission,
    start: () => Promise<ContentListJob>,
  ): Promise<ContentListJob>;
  update(job: ContentListJob): void;
}

export interface ContentListJobControllerOptions {
  /** A retry starts a new attempt and must resolve with a distinct job id. */
  retry?: (job: ContentListJob) => Promise<ContentListJob>;
  /** Terminal attempts retained for status UI. Active work is never evicted. */
  maxTerminalJobs?: number;
}

const ACTIVE_JOB_STATUSES = new Set<ContentListJobStatus>([
  'queued',
  'running',
]);
const DEFAULT_MAX_TERMINAL_JOBS = 50;

function isActive(job: ContentListJob): boolean {
  return ACTIVE_JOB_STATUSES.has(job.status);
}

function normalizedTarget(target: ContentListJobTarget): ContentListJobTarget {
  if (target.kind === 'query') return { ...target };
  return { kind: 'rows', rowIds: [...new Set(target.rowIds.map(String))] };
}

function cloneJob(job: ContentListJob): ContentListJob {
  return { ...job, target: normalizedTarget(job.target) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'The background job failed.';
}

function snapshotOf(
  jobs: ReadonlyMap<string, ContentListJob>,
): ContentListJobSnapshot {
  const pendingRowIds = new Set<string>();
  const pendingQueryKeys = new Set<string>();
  for (const job of jobs.values()) {
    if (!isActive(job)) continue;
    if (job.target.kind === 'rows') {
      for (const rowId of job.target.rowIds) pendingRowIds.add(String(rowId));
    } else {
      pendingQueryKeys.add(job.target.queryKey);
    }
  }
  return {
    jobs: [...jobs.values()].map(cloneJob),
    pendingRowIds,
    pendingQueryKeys,
  };
}

/**
 * Creates the shared job tracker used by ContentList action controls.
 *
 * A second `submit()` with the same active `submissionKey` receives the first
 * promise and never invokes its own starter. Terminal failures stay failures
 * until an explicit retry succeeds; no optimistic success state is emitted.
 */
export function createContentListJobController(
  options: ContentListJobControllerOptions = {},
): ContentListJobController {
  const jobs = new Map<string, ContentListJob>();
  const activeBySubmission = new Map<string, string>();
  const submissions = new Map<string, Promise<ContentListJob>>();
  const retrying = new Map<string, Promise<ContentListJob>>();
  const retriedAttempts = new Set<string>();
  const retrySources = new Set<string>();
  const listeners = new Set<(snapshot: ContentListJobSnapshot) => void>();
  const maxTerminalJobs =
    options.maxTerminalJobs !== undefined &&
    Number.isFinite(options.maxTerminalJobs)
      ? Math.max(1, Math.floor(options.maxTerminalJobs))
      : DEFAULT_MAX_TERMINAL_JOBS;
  let provisionalSequence = 0;

  const pruneTerminalJobs = (): void => {
    const removable = [...jobs.values()].filter(
      (job) => !isActive(job) && !retrySources.has(job.jobId),
    );
    for (const job of removable.slice(0, -maxTerminalJobs)) {
      jobs.delete(job.jobId);
      retriedAttempts.delete(job.jobId);
    }
  };

  const publish = (): void => {
    pruneTerminalJobs();
    const snapshot = snapshotOf(jobs);
    for (const listener of listeners) listener(snapshot);
  };

  const settleActiveKey = (job: ContentListJob): void => {
    if (isActive(job)) activeBySubmission.set(job.submissionKey, job.jobId);
    else if (activeBySubmission.get(job.submissionKey) === job.jobId)
      activeBySubmission.delete(job.submissionKey);
  };

  const update = (next: ContentListJob): void => {
    const job = cloneJob(next);
    const previous = jobs.get(job.jobId);
    // A terminal server event is immutable. Replayed/out-of-order progress or
    // a conflicting terminal event may not rewrite the result. `retry()` owns
    // the one deliberate transition back to queued state below.
    if (previous && !isActive(previous)) return;
    jobs.set(job.jobId, job);
    settleActiveKey(job);
    publish();
  };

  const submit = (
    submission: ContentListJobSubmission,
    start: () => Promise<ContentListJob>,
  ): Promise<ContentListJob> => {
    const existing = submissions.get(submission.submissionKey);
    if (existing) return existing;
    const activeId = activeBySubmission.get(submission.submissionKey);
    if (activeId) {
      const active = jobs.get(activeId);
      if (active) return Promise.resolve(cloneJob(active));
      activeBySubmission.delete(submission.submissionKey);
    }

    const provisionalId = `content-list:submission:${++provisionalSequence}`;
    const provisional: ContentListJob = {
      jobId: provisionalId,
      actionId: submission.actionId,
      submissionKey: submission.submissionKey,
      status: 'queued',
      target: normalizedTarget(submission.target),
    };
    jobs.set(provisionalId, provisional);
    activeBySubmission.set(submission.submissionKey, provisionalId);
    publish();

    let started: Promise<ContentListJob>;
    try {
      started = start();
    } catch (error) {
      started = Promise.reject(error);
    }
    const promise = Promise.resolve(started)
      .then((accepted) => {
        jobs.delete(provisionalId);
        if (activeBySubmission.get(submission.submissionKey) === provisionalId)
          activeBySubmission.delete(submission.submissionKey);
        const job = cloneJob({
          ...accepted,
          actionId: submission.actionId,
          submissionKey: submission.submissionKey,
          target: normalizedTarget(submission.target),
        });
        update(job);
        return cloneJob(job);
      })
      .catch((error) => {
        const failed: ContentListJob = {
          ...provisional,
          status: 'failed',
          error: errorMessage(error),
        };
        update(failed);
        throw error;
      })
      .finally(() => submissions.delete(submission.submissionKey));
    submissions.set(submission.submissionKey, promise);
    return promise;
  };

  const retry = (jobId: string): Promise<ContentListJob> => {
    const current = jobs.get(jobId);
    const existing = retrying.get(jobId);
    if (existing) return existing;
    if (current?.status !== 'failed')
      return Promise.reject(
        new Error('Only a failed content job can be retried.'),
      );
    if (retriedAttempts.has(jobId))
      return Promise.reject(
        new Error('This content job attempt has already been retried.'),
      );
    if (!options.retry)
      return Promise.reject(
        new Error('No content job retry handler is configured.'),
      );

    retriedAttempts.add(jobId);
    retrySources.add(jobId);
    const retryId = `content-list:retry:${++provisionalSequence}`;
    const pending = {
      ...current,
      jobId: retryId,
      status: 'queued' as const,
      error: undefined,
    };
    jobs.set(retryId, pending);
    settleActiveKey(pending);
    publish();
    let started: Promise<ContentListJob>;
    try {
      started = options.retry(cloneJob(current));
    } catch (error) {
      started = Promise.reject(error);
    }
    const promise = Promise.resolve(started)
      .then((next) => {
        if (next.jobId === jobId)
          throw new Error('A content job retry must use a distinct job id.');
        const retried = cloneJob({
          ...next,
          actionId: current.actionId,
          submissionKey: current.submissionKey,
          target: current.target,
        });
        jobs.delete(retryId);
        if (activeBySubmission.get(current.submissionKey) === retryId)
          activeBySubmission.delete(current.submissionKey);
        update(retried);
        return cloneJob(retried);
      })
      .catch((error) => {
        const failed = {
          ...pending,
          status: 'failed' as const,
          error: errorMessage(error),
        };
        update(failed);
        throw error;
      })
      .finally(() => {
        retrying.delete(jobId);
        retrySources.delete(jobId);
        // The source attempt was protected while its retry was in flight. Once
        // settled, restore the configured terminal-history bound.
        publish();
      });
    retrying.set(jobId, promise);
    return promise;
  };

  return {
    snapshot: () => snapshotOf(jobs),
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshotOf(jobs));
      return () => listeners.delete(listener);
    },
    canRetry: (jobId) => {
      const job = jobs.get(jobId);
      return (
        options.retry !== undefined &&
        job?.status === 'failed' &&
        !retriedAttempts.has(jobId)
      );
    },
    submit,
    update,
    retry,
  };
}

/** True only when a successful job can affect the currently rendered answer. */
export function contentListJobAffectsQuery(
  job: ContentListJob,
  queryKey: string | undefined,
  visibleRowIds: ReadonlySet<string>,
): boolean {
  if (job.status !== 'succeeded') return false;
  if (job.target.kind === 'query')
    return queryKey !== undefined && job.target.queryKey === queryKey;
  return job.target.rowIds.some((rowId) => visibleRowIds.has(String(rowId)));
}
