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
4. Resolves class via `ObjectRegistry.getClass(objectType)`, creates instance, calls method
5. **Internal args**: `_agentConfig` and `_scheduleId` stripped from args before calling method
6. Terminal/retry writes are **conditional** (`WHERE worker_id=? AND status='running'`) so a recovered row is never stomped
7. Retry: uses strategy from `@happyvertical/jobs`, schedules future `runAt` on failure
8. Events: `job:started`, `job:completed`, `job:failed`, `job:retrying`, `runner:started/stopped`

## Worker liveness & recovery (#1474)

Recovery keys on **worker-process liveness**, never per-job heartbeat freshness (a CPU-bound synchronous handler used to starve the heartbeat and false-recover its own running jobs).

- **`SmrtWorker` / `_smrt_workers`**: one lease row per runner *incarnation* (`workerId` is per-incarnation unique via `createWorkerKey`, so a restart never looks like it still owns the previous crash's jobs). `leaseExpiresAt` is a `datetime` (an integer epoch-ms column overflows `int4`/`INT32` on Postgres/DuckDB). Stage 1 writes/compares it against the host clock — the same approach the old heartbeat recovery used, so it's no more skew-sensitive than the code it replaced.
- **Process-global live set** (`worker-liveness.ts`, `globalThis.__smrtLiveWorkers`): checked synchronously, so it can't be starved by a blocked loop. Covers all same-process topologies.
- **Off-loop ticker** (`worker-liveness-ticker.ts` + `worker-liveness-thread.ts`): for engines a second connection can reach (Postgres, file-backed SQLite — `offLoopEligible()`), `start()` spawns a `node:worker_threads` ticker that renews the lease on its own thread, so a CPU-bound synchronous handler on the main loop can't starve it. In-memory SQLite / DuckDB, a thread-spawn failure, a start-handshake timeout, or the thread dying mid-run all fall back to main-loop renewal; the in-process live set keeps same-process correct regardless. The worker entry is a separate build entry resolved via `import.meta.resolve('@happyvertical/smrt-jobs/worker-liveness-thread')`.
- **Recovery rule** (both runners): a `running` job is orphaned iff its worker is *not alive* = not in the live set **and** no fresh `_smrt_workers` lease. The live set takes precedence over a stale lease. TaskRunner also never recovers a job in its own `activeJobs`. If `_smrt_workers` is absent, recovery skips lease checks (never mass-recovers). Recovery is swept at most once per lease tick, and terminal/recovery writes use `RETURNING id` (not `rowCount`, which DuckDB/JSON adapters always report as ≥1).
- **Lease clock**: the lease is compared against the host clock (same as the old heartbeat; fine with NTP + a 30s TTL). A dead process stops renewing and the lease expires within its TTL — that is how recovery detects death. (Instant cross-process detection via Postgres session advisory locks was prototyped on `@happyvertical/sql`'s `acquireSession()` but deferred — treating a free lock as proof-of-death false-recovers any worker legitimately in main-loop fallback mode.)

## ScheduleRunner

Polls `_smrt_agent_schedules` every 60s for due entries. Creates SmrtJob with `queue='agents'`, `priority=75`. Wires to TaskRunner events for completion/failure tracking. Slot reconciliation keys on worker liveness (it has no in-process active-job set, so the lease/live-set is its whole mechanism).

Custom cron parser: 5-field (minute hour dom month dow). `*`, ranges, lists, steps supported. **Not timezone-aware** (UTC).

## JobBuilder — Fluent API

```typescript
const handle = await doc.background('analyze', { detailed: true })
  .delay('5m').priority('high').retries(5).queue('analysis').timeout(600000).enqueue();

await handle.wait({ timeout: 60000, pollInterval: 100 }); // polling-based
```

`bg()` is shorthand: `await doc.bg('analyze', args)` → enqueues immediately, returns JobHandle.

## withBackgroundJobs(Class)

Mixin that adds `bg()` and `background()` to any SmrtObject. Uses WeakMap for collection caching per DB instance.

## Gotchas

- **Cron not timezone-aware**: all times treated as UTC
- **No dead letter queue**: failed jobs stay in DB with `status='failed'` — manual intervention
- **Result storage**: `resultPointer` is just a string — app must implement result backend
- **Lazy builder**: `background()` returns builder — nothing happens until `enqueue()`
- **wait() is polling**: JobHandle.wait() polls DB every 100ms (configurable)
- **Migrate before start()**: `TaskRunner.start()` throws if `_smrt_workers` is missing — run `smrt db:migrate` after upgrading. Tables are never created at runtime.
- **Recovery is liveness-based**: don't reintroduce heartbeat-threshold recovery; a blocked event loop must not look dead (see Worker liveness section, #1474)
