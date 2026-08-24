# @happyvertical/smrt-jobs

Background job execution with persistent queue, scheduling, and fluent builder API.

## Architecture

```
SmrtObject.bg('method') → SmrtJob (in _smrt_jobs) → TaskRunner picks up → executes via ObjectRegistry
AgentSchedule (cron) → ScheduleRunner creates SmrtJob → TaskRunner executes → ScheduleRunner updates
TaskRunner.start() → SmrtWorker lease (in _smrt_workers) → recovery keys on worker liveness, not heartbeat
```

## SmrtJob

Persistent in `_smrt_jobs`. Fields: `queue` (default), `objectType`, `objectId`, `method`, `args`, `runAt`, `priority` (higher=sooner), `status`, `attempts`/`maxAttempts`, `timeout` (default 5min), `retryStrategy`, `workerId` (the owning runner's incarnation key), `workerHeartbeat` (telemetry only — no longer gates recovery).

Status: `pending → running → completed/failed/cancelled`.

## TaskRunner

Polling-based execution engine. Config: `concurrency` (5), `pollInterval` (1s), `heartbeatInterval` (30s, telemetry only), `leaseTtlMs` (30s), `leaseTickMs` (10s), `shutdownTimeout` (30s).

1. `start()` calls `assertReady()` (fail fast if `_smrt_workers` unmigrated), registers a seeded `SmrtWorker` lease, and adds its worker key to the process-global live set — all **before** polling
2. Polls `claimReady()` to atomically claim pending jobs (`runAt <= NOW`, ordered by `priority DESC, runAt ASC, created_at ASC, id ASC`)
3. Claim sets `status='running'`, `workerId=<incarnation key>`, heartbeat/start timestamps, and increments `attempts`
4. Resolves class via `ObjectRegistry.getClass(objectType)`. Object-bound jobs
   pass `objectId` to the constructor and let `initialize()` perform the single
   canonical hydration. Runner-owned `db`, `id`, and hydration options cannot be
   overridden by agent config; missing persisted targets fail before method
   dispatch. Jobs without `objectId` construct a static-like instance
5. **Internal args**: `_agentConfig` and `_scheduleId` stripped from args before calling method
6. Calls the requested method on the initialized instance
7. Terminal/retry writes are **conditional** (`WHERE worker_id=? AND status='running'`) so a recovered row is never stomped
8. Retry: uses strategy from `@happyvertical/jobs`, schedules future `runAt` on failure
9. Events: `job:started`, `job:completed`, `job:failed`, `job:retrying`, `runner:started/stopped`

A rejection from `processJob` can never escape the poll loop: the caller attaches `.catch(e => emit('runner:error', e))` and the error path (`handleJobError`) is itself try/caught, so a failure-path write that rejects is surfaced as a `runner:error` event instead of crashing the worker with an unhandled rejection.

## Timeouts & at-least-once

**Execution is at-least-once, never exactly-once. Make job handlers idempotent.**

A job `timeout` only races the handler's promise — JavaScript cannot preempt an already-running function. When a handler exceeds its timeout:

- The job is **failed terminally and NOT auto-retried** (a timed-out handler is still running; re-queueing it would let a second worker run a concurrent duplicate). This narrows, but does not eliminate, the overlap window — the orphaned handler keeps running until it returns on its own.
- The orphaned handler's eventual terminal write is dropped by the ownership guard (`WHERE worker_id=? AND status='running'`), so it cannot resurrect the failed row — but any **side effects** it performs (external API calls, writes to other tables) still happen.
- Key any non-idempotent work by `context.job.jobId` or a caller-supplied idempotency key.

`timeoutBehavior` (persisted + shown in the UI) is now honored:

- **`'fail'`** (default): on timeout the job fails (and, per above, is not retried).
- **`'warn'`**: the handler is **not** raced against the timeout — it runs to completion, and at the deadline the runner logs a warning and emits a `timeout-warning` job event. A slow-but-successful handler still completes successfully.
- **`'kill'`**: treated identically to `'fail'`. In-process JavaScript has no thread interruption, so a true "kill" of a running handler is impossible without worker isolation; this value is honest that it only fails the job row, it does not stop the handler. Prefer `'fail'` unless you specifically want the label.

## Worker liveness & recovery (#1474)

Recovery keys on **worker-process liveness**, never per-job heartbeat freshness (a CPU-bound synchronous handler used to starve the heartbeat and false-recover its own running jobs).

- **`SmrtWorker` / `_smrt_workers`**: one lease row per runner *incarnation* (`workerId` is per-incarnation unique via `createWorkerKey`, so a restart never looks like it still owns the previous crash's jobs). `leaseExpiresAt` is a `datetime` (an integer epoch-ms column overflows `int4`/`INT32` on Postgres/DuckDB). Stage 1 writes/compares it against the host clock — the same approach the old heartbeat recovery used, so it's no more skew-sensitive than the code it replaced.
- **Process-global live set** (`worker-liveness.ts`, `globalThis.__smrtLiveWorkers`): checked synchronously, so it can't be starved by a blocked loop. Covers all same-process topologies.
- **Off-loop ticker** (`worker-liveness-ticker.ts` + `worker-liveness-thread.ts`): for engines a second connection can reach (Postgres, file-backed SQLite — `offLoopEligible()`), `start()` spawns a `node:worker_threads` ticker that renews the lease on its own thread, so a CPU-bound synchronous handler on the main loop can't starve it. In-memory SQLite / DuckDB, a thread-spawn failure, a start-handshake timeout, or the thread dying mid-run all fall back to main-loop renewal; the in-process live set keeps same-process correct regardless. The worker entry is a separate build entry resolved via `import.meta.resolve('@happyvertical/smrt-jobs/worker-liveness-thread')`.
- **Recovery rule** (both runners): a `running` job is orphaned iff its worker is *not alive* = not in the live set **and** no fresh `_smrt_workers` lease. The live set takes precedence over a stale lease. TaskRunner also never recovers a job in its own `activeJobs`. If `_smrt_workers` is absent, recovery skips lease checks (never mass-recovers). Recovery is swept at most once per lease tick, and terminal/recovery writes use `RETURNING id` (not `rowCount`, which DuckDB/JSON adapters always report as ≥1).
- **Lease clock**: the lease is compared against the host clock (same as the old heartbeat; fine with NTP + a 30s TTL). A dead process stops renewing and the lease expires within its TTL — that is how recovery detects death. (Instant cross-process detection via Postgres session advisory locks was prototyped on `@happyvertical/sql`'s `acquireSession()` but deferred — treating a free lock as proof-of-death false-recovers any worker legitimately in main-loop fallback mode.)

## ScheduleRunner

Polls `_smrt_agent_schedules` every 60s for due entries. Creates SmrtJob with `queue='agents'`, `priority=75`. Wires to TaskRunner events for completion/failure tracking. Slot reconciliation keys on worker liveness (it has no in-process active-job set, so the lease/live-set is its whole mechanism).

The job is enqueued **before** `next_run` is advanced and `running_count` is incremented: a transient enqueue failure (tenant-cap hit, DB blip) therefore leaves `next_run` and `status='active'` untouched so the same due slot is retried on the next poll, rather than losing the slot and disabling the schedule.

`next_run` is always recomputed from *now*, never from the previous `next_run` — this is **fire-once-forward**: runs that came due while the runner was down are not caught up, only the next future occurrence fires. There is no missed-run backfill.

Custom cron parser: 5-field (minute hour dom month dow). `*`, ranges, lists, steps supported. **Not timezone-aware**: cron fields are matched against the **server's local time** (the parser uses `getHours`/`getDate`/`getDay`/… local accessors), so `0 0 * * *` fires at local midnight on the host, not at 00:00 UTC. Deploy runners in a known timezone (e.g. `TZ=UTC`) for UTC semantics. A per-schedule timezone option is a possible future enhancement.

## JobBuilder — Fluent API

```typescript
const handle = await doc.background('analyze', { detailed: true })
  .delay('5m').priority('high').retries(5).queue('analysis').timeout(600000).enqueue();

await handle.wait({ timeout: 60000, pollInterval: 100 }); // polling-based
```

## Durable forge projections

`ForgeDeliveryCollection` owns the provider-neutral delivery inbox in
`_smrt_forge_deliveries`; `ForgeProjectionRuntime` owns lease/retry/dead-letter
transitions and monotonic checkpoints in
`_smrt_forge_projection_checkpoints`.

- Inbox identity is `(tenant_id, provider, delivery_id)`.
- Tenant-facing accept/replay requires ambient tenant context. Worker claim is
  cross-tenant, then runtime restores the captured context before observation.
- Projection callbacks must write through `ForgeProjectionContext.db`; the
  application projection, checkpoint, and inbox completion share one
  transaction.
- Observation identity is tracker-independent
  `(projection, subjectKey, version)`. Equal or older versions are acknowledged
  without reapplying.
- Lease-token conditions guard every terminal/failure write. Expired final
  attempts become replayable `dead_letter` rows, and persisted errors are
  redacted.
- Generated API, CLI, and MCP surfaces stay disabled; replay is an explicit
  tenant-scoped operator action.

`bg()` is shorthand: `await doc.bg('analyze', args)` → enqueues immediately, returns JobHandle.

## withBackgroundJobs(Class)

Mixin that adds `bg()` and `background()` to any SmrtObject. Uses WeakMap for collection caching per DB instance.

## Background policy (`background-policy.ts`, S5 audit #1402)

Three opt-in guards, all owned **and enforced here**. Other packages apply the
eligibility marker (`reports`, `support`, `fields`, the MCP conformance
fixture), but nothing outside this package acts on it — `TaskRunner` is the only
reader. In particular `@happyvertical/smrt-agents` has no reference to any of
these guards and does not depend on this package, so marking a method does not
change what the agents runtime will dispatch.

- `clampRetries()` / `MAX_JOB_RETRIES` (25): a requested retry count above the
  ceiling is clamped, not rejected.
- `assertWithinTenantCreationCap(tenantId, current, cap)` /
  `DEFAULT_TENANT_JOB_CAP` (10 000): throws `TenantJobCapExceededError` when the
  tenant's count of non-terminal jobs is already at or above the cap. Applied in
  `SmrtJobCollection.enqueueJob()` (`smrt-job.ts`), which is the single choke
  point for the builder and `ScheduleRunner`; a `null` tenant and a `cap <= 0`
  both skip the check. Deliberately not serialized — concurrent enqueues can
  overshoot by the number of in-flight creators (see the method's own comment).
- `@backgroundEligible()` / `markBackgroundEligible()` /
  `isBackgroundEligibleMethod()`: an allowlist of methods `TaskRunner` may
  dispatch, enforced at exactly one call site (`runner.ts`, after the method
  lookup). **Restrictive, not enabling** — a class with no marked methods allows
  any of its methods, and the first mark makes the set exhaustive, excluding
  every sibling method. Adding the decorator to one method of an existing class
  is therefore a behaviour change for the rest of it.

## Retention (#2375)

`_smrt_jobs` and `_smrt_job_events` are append-only in practice — `cleanup()`
existed but nothing ever called it, and job events (one row per log line and
progress tick) had no prune path at all. `src/retention.ts` contributes both to
the framework retention sweep in `@happyvertical/smrt-core`.

- `TaskRunner` starts a sweeper by default. `retention: false` opts out;
  `retention: { intervalMs, policy, jobs }` tunes it. The **first sweep is one
  interval after `start()`, never at start** — a crash-looping worker must not
  become a delete loop, and a short-lived runner must exit having deleted
  nothing. `stop()` only clears the timer — it does **not** unregister the job
  tasks. The package entry point (`index.ts`) registers them unconditionally
  on import, so "this process loaded `@happyvertical/smrt-jobs`" is the
  contract that contributes them, not "a sweeper happens to be running";
  `unregisterJobRetentionTasks()` is the explicit opt-out for callers that
  want a clean registry (tests, teardown).
- Windows (`DEFAULT_JOB_RETENTION`): completed/cancelled 7 days, failed 30
  days, events 30 days, 10 000 job rows per sweep. Events deliberately outlive
  the jobs they describe, so a job row removed at 7 days still has a readable
  log for another three weeks. `SmrtJobEvent.jobId` is therefore the explicit
  same-package archival exception: `@foreignKey('SmrtJob', { constraint:
  false })` retains runtime relationship metadata and its index without a
  physical database constraint that would block parent pruning.
- `cleanup()` counts before deleting (`rowCount` is unreliable across engines)
  and honours `dryRun`, which is what makes `smrt db:prune --dry-run` an exact
  preview. Its `(status, completed_at)` predicate is indexed by
  `ensureJobsSystemTableCompatibility()`, which this collection runs on every
  `initialize()` — bootstrap cannot do it, because `_smrt_jobs` does not exist
  yet when bootstrap runs.
- `cleanup({})` with no cutoff returns 0. It must never be read as "delete
  everything".

## Gotchas

- **Cron not timezone-aware**: cron fields match the server's **local** time, not UTC (set `TZ` for UTC); no missed-run catch-up (fire-once-forward)
- **At-least-once execution**: a timeout cannot preempt a running handler; timed-out jobs fail without retry but the handler keeps running — make handlers idempotent (see "Timeouts & at-least-once")
- **No dead letter queue**: failed jobs stay in DB with `status='failed'` — manual intervention
- **Forge deliveries are not SmrtJobs**: they use their own replayable
  dead-letter inbox and projection checkpoint contract. Do not enqueue provider
  deliveries as generic background jobs.
- **Result storage**: `resultPointer` is just a string — app must implement result backend
- **Lazy builder**: `background()` returns builder — nothing happens until `enqueue()`
- **wait() is polling**: JobHandle.wait() polls DB every 100ms (configurable)
- **Migrate before start()**: `TaskRunner.start()` throws if `_smrt_workers` is missing — run `smrt db:migrate` after upgrading. Tables are never created at runtime.
- **Recovery is liveness-based**: don't reintroduce heartbeat-threshold recovery; a blocked event loop must not look dead (see Worker liveness section, #1474)
