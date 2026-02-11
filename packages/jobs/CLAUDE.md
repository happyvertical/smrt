# @happyvertical/smrt-jobs

Background job processing and scheduling for SMRT objects. Provides persistent job queues with retries, priority, and concurrent execution.

## Architecture

```
src/
  index.ts              # Export barrel
  smrt-job.ts           # Persistent job model
  job-builder.ts        # Fluent API for job configuration
  job-handle.ts         # Tracking handle with .wait()
  task-runner.ts        # Concurrent job processor (separate export: ./runner)
  schedule-runner.ts    # Cron-like scheduling
  job-context-logger.ts # Contextual logging during execution
  mixin.ts              # withBackgroundJobs() mixin for SmrtObject
```

## Key Exports

- `SmrtJob` — Persistent job record with status, retries, timeout
- `TaskRunner` — Processes jobs concurrently with polling and heartbeat
- `ScheduleRunner` — Executes schedule-based jobs
- `JobBuilder` — Fluent configuration API (delay, retries, priority)
- `JobHandle` — Tracking handle with `.wait()` for result polling
- `withBackgroundJobs()` — Mixin that adds `.bg()` and `.background()` to any SmrtObject

## Key Patterns

- **Fluent API**: `obj.background().delay('5m').retries(3).priority('high').run('methodName', args)`
- **Simple API**: `obj.bg('methodName', args)` for quick fire-and-forget
- **Priority levels**: critical (100), high (75), normal (50), low (25)
- **Delay parsing**: Supports `ms`, `s`, `m`, `h`, `d` suffixes
- **TaskRunner export**: Available at `@happyvertical/smrt-jobs/runner` (separate entry point)

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-config`
- `@happyvertical/jobs`, `@happyvertical/logger`, `@happyvertical/sql`, `@happyvertical/utils`
