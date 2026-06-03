# @happyvertical/smrt-jobs

Background job execution with persistent queue, scheduling, and fluent builder API.

## Architecture

```
SmrtObject.bg('method') → SmrtJob (in _smrt_jobs) → TaskRunner picks up → executes via ObjectRegistry
AgentSchedule (cron) → ScheduleRunner creates SmrtJob → TaskRunner executes → ScheduleRunner updates
```

## SmrtJob

Persistent in `_smrt_jobs`. Fields: `queue` (default), `objectType`, `objectId`, `method`, `args`, `runAt`, `priority` (higher=sooner), `status`, `attempts`/`maxAttempts`, `timeout` (default 5min), `retryStrategy`, `workerId`, `workerHeartbeat`.

Status: `pending → running → completed/failed/cancelled`.

## TaskRunner

Polling-based execution engine. Config: `concurrency` (5), `pollInterval` (1s), `heartbeatInterval` (30s), `shutdownTimeout` (30s).

1. Polls `listReady()` for pending jobs (`runAt <= NOW`, ordered by `priority DESC, runAt ASC`)
2. Claims atomically: `status='running', workerId=this.id`
3. Resolves class via `ObjectRegistry.getClass(objectType)`, creates instance, calls method
4. **Internal args**: `_agentConfig` and `_scheduleId` stripped from args before calling method
5. Retry: uses strategy from `@happyvertical/jobs`, schedules future `runAt` on failure
6. Events: `job:started`, `job:completed`, `job:failed`, `job:retrying`, `runner:started/stopped`

## ScheduleRunner

Polls `_smrt_agent_schedules` every 60s for due entries. Creates SmrtJob with `queue='agents'`, `priority=75`. Wires to TaskRunner events for completion/failure tracking.

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
