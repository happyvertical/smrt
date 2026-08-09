# @happyvertical/smrt-jobs

## Durable forge projections

`ForgeDeliveryCollection` and `ForgeProjectionRuntime` provide a
provider-neutral inbox for durable forge webhook projection. The inbox identity
is `(tenantId, provider, deliveryId)`, so provider retries are atomically
deduplicated. A worker lease owns each attempt; failures use bounded exponential
retry, then remain in `dead_letter` until an operator calls `replay()` from the
owning tenant context.

`leaseMs` must be a finite positive duration. `retryBaseMs` and `retryMaxMs`
must be finite, non-negative durations no greater than 2,147,483,647 ms;
invalid timing configuration is rejected before a lease can be claimed. A lease
that would exceed the JavaScript `Date` range is rejected before any lease
write; a retry that would exceed that range is durably dead-lettered instead of
being left leased.

```ts
const inbox = await ForgeDeliveryCollection.create({ db });

await withTenant({ tenantId }, () =>
  inbox.accept({
    provider: 'github',
    deliveryId: request.headers.get('x-github-delivery')!,
    eventName: 'pull_request',
    repositoryKey: 'example/forge-repository',
    payload,
  }),
);

const runtime = new ForgeProjectionRuntime({ db, workerId: workerKey });
await runtime.processNext({
  async observe(delivery) {
    return {
      projection: 'pull-request-revision',
      subjectKey: `${delivery.repositoryKey}:pr:${delivery.payload.number}`,
      version: Number(delivery.payload.revision),
      value: delivery.payload,
    };
  },
  async project(observation, context) {
    // Always use context.db: it is the transaction shared by the application
    // projection, monotonic checkpoint, and inbox completion.
    await writeProjection(context.db, observation);
  },
});
```

`projection` and `subjectKey` are application-defined. A pull request is not
treated as a tracker issue. `version` must be a non-negative monotonic signed
32-bit integer (`0` through `2,147,483,647`); observations at or below the
durable checkpoint are acknowledged without reapplying side effects. Provider
normalization runs with the delivery's tenant context restored. Generated
REST/MCP/CLI surfaces are disabled for both system tables; operator replay
requires an explicit in-process tenant context.

The manifest-driven migration adds `_smrt_forge_deliveries` and
`_smrt_forge_projection_checkpoints`. Run `smrt db:migrate` before starting a
forge projection worker.

Background job execution for s-m-r-t objects. Provides persistent queue storage, retry strategies, cron-based scheduling, and a fluent `JobBuilder` API via the `withBackgroundJobs()` mixin.

## Installation

```bash
pnpm add @happyvertical/smrt-jobs
```

## Usage

### Add background capabilities to a SmrtObject

```typescript
import { withBackgroundJobs, TaskRunner } from '@happyvertical/smrt-jobs';
import { Document } from './document.js';

// Mixin adds .bg() and .background() to any SmrtObject class
const BackgroundDocument = withBackgroundJobs(Document);
const doc = new BackgroundDocument({ db });
await doc.initialize();

// Quick enqueue — runs immediately when a TaskRunner picks it up
const handle = await doc.bg('generateSummary', { format: 'md' });

// Fluent builder for advanced options
const handle2 = await doc.background('generateSummary', { format: 'md' })
  .delay('5m')
  .priority('high')
  .retries(5)
  .queue('analysis')
  .timeout(600000)
  .enqueue();

// Wait for result (polling-based)
const result = await handle2.wait({ timeout: 60000, pollInterval: 100 });
```

### Run a TaskRunner to process jobs

```typescript
import { TaskRunner } from '@happyvertical/smrt-jobs';

const runner = new TaskRunner({
  concurrency: 5,
  pollInterval: 1000,
  queues: ['default', 'analysis'],
});
await runner.initialize(db);
await runner.start();

// Listen for events
runner.on('job:completed', (job, result) => { /* ... */ });
runner.on('job:failed', (job, error) => { /* ... */ });

// Graceful shutdown
process.on('SIGTERM', () => runner.stop());
```

### Back MCP task operations with durable jobs

`McpTaskStore` persists the MCP `io.modelcontextprotocol/tasks` lifecycle on
the same `_smrt_jobs` row that executes the operation. `createTask()` creates a
correlated job, `getTask()` maps its queue state, and `cancelTask()` cancels
that exact job without leaving a second record behind. Long-running task
actions can request client input through `JobExecutionContext.task`:

```typescript
async generate(context: JobExecutionContext) {
  const { tone } = await context.task!.requestInput({ tone: { type: 'string' } });
  return this.render(tone);
}
```

Run a `TaskRunner` for the `mcp-tasks` queue in application deployments. Task
cancellation is cooperative: the job row becomes cancelled immediately and a
running handler must observe its context before doing further side effects.

### Liveness-safe job execution

`TaskRunner` records heartbeat telemetry, but recovery keys on a worker
incarnation's live lease rather than a per-job heartbeat threshold. A blocked
event loop must not make a still-running handler appear dead and cause a
concurrent duplicate execution. See the live-set and off-loop lease-renewal
details in
[Worker liveness & recovery](AGENTS.md#worker-liveness--recovery-1474).

Job handlers remain at-least-once. Avoid synchronous, CPU-bound, or otherwise
long-running work when possible; make external effects idempotent because a
process crash after an effect but before its terminal write still permits a
later retry.

### Schedule recurring jobs with ScheduleRunner

The `ScheduleRunner` polls the `_smrt_agent_schedules` table for due cron entries and creates `SmrtJob` records for the `TaskRunner` to execute. Wire them together via events:

```typescript
import { ScheduleRunner } from '@happyvertical/smrt-jobs';

const scheduleRunner = new ScheduleRunner({ pollInterval: 30000 });
await scheduleRunner.initialize(db);
await scheduleRunner.start();

// Connect TaskRunner events to update schedule state
taskRunner.on('job:completed', (job) => {
  const scheduleId = job.args?._scheduleId;
  if (scheduleId) scheduleRunner.handleJobCompletion(scheduleId, true);
});
taskRunner.on('job:failed', (job, error) => {
  const scheduleId = job.args?._scheduleId;
  if (scheduleId) scheduleRunner.handleJobCompletion(scheduleId, false, error.message);
});
```

### System Tables

| Table | Purpose |
|-------|---------|
| `_smrt_jobs` | Persistent job queue (SmrtJob records) |
| `_smrt_agent_schedules` | Cron schedule entries polled by ScheduleRunner |

## API

### Classes

| Export | Description |
|--------|------------|
| `SmrtJob` | Persistent job record stored in `_smrt_jobs` |
| `SmrtJobCollection` | Collection with `claimReady()`, `listReady()`, `listByStatus()`, `stats()`, `cleanup()` |
| `JobBuilder` | Fluent API: `.delay()`, `.priority()`, `.retries()`, `.queue()`, `.timeout()`, `.enqueue()` |
| `JobHandle` | Track, wait, cancel, or retry an enqueued job |
| `JobContextLogger` | Logger that auto-injects job context (jobId, attempt, queue) |
| `TaskRunner` | Polling-based execution engine with concurrency control and liveness leases |
| `ScheduleRunner` | Polls for due cron schedules and creates SmrtJob entries |

`TaskRunner` uses `SmrtJobCollection.claimReady()` so multiple workers can poll
the same queue without duplicate-claiming a pending row.

### Functions

| Export | Description |
|--------|------------|
| `createTaskRunner(config?)` | Factory for creating a configured TaskRunner |
| `createScheduleRunner(config?)` | Factory for creating a configured ScheduleRunner |
| `withBackgroundJobs(Class)` | Mixin that adds `.bg()` and `.background()` to any SmrtObject class |
| `parseDelay(delay)` | Parse human-readable delay strings (`'5m'`, `'1h'`, `'30s'`) to milliseconds |
| `priorityToNumber(priority)` | Convert priority label (`'critical'`/`'high'`/`'normal'`/`'low'`) to number |

### Key Types

`Priority`, `JobStatus`, `JobResult`, `WaitOptions`, `BgOptions`, `BackgroundCapable`, `TaskRunnerConfig`, `TaskRunnerEvents`, `ScheduleRunnerConfig`, `ScheduleRunnerEvents`, `ScheduleInfo`, `JobContext`, `TimeoutBehavior`, `SmrtJobData`, `ListReadyOptions`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-types` -- shared type definitions
- `@happyvertical/jobs` -- retry strategies
- `@happyvertical/sql` -- database interface
- `@happyvertical/logger` -- structured logging
- `@happyvertical/utils` -- ID generation utilities
- Peer (optional): `@happyvertical/smrt-svelte`, `svelte`
