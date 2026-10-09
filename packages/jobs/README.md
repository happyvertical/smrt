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
  // Empty checks back off exponentially to this cap (20× by default).
  idlePollInterval: 20000,
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

Polling delays are capped at the effective worker lease TTL, including a larger
`pollInterval`, to bound orphan-recovery sweep spacing. Both polling intervals
must be finite positive milliseconds within the Node timer range. The default
20× idle cap reduces combined claim and recovery traffic; latency-sensitive
workers can set a smaller cap.

### Back MCP task operations with durable jobs

`McpTaskStore` persists the MCP `io.modelcontextprotocol/tasks` lifecycle on
the same `_smrt_jobs` row that executes the operation. `createTask()` creates a
correlated job, `getTask()` maps its queue state, and `cancelTask()` cancels
that exact job without leaving a second record behind. Long-running task
actions can request client input through `JobExecutionContext.task`:

```typescript
async generate(options: Record<string, never>, context: JobExecutionContext) {
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

### Read safe terminal outcomes

Completion, permanent failure, timeout, stale-worker recovery, and cancellation
persist the job's terminal state and a versioned `_smrt_job_events` outcome in
one database transaction. A retry remains nonterminal and is not projected.
Ordinary progress and log events remain best-effort telemetry.
The event uses the row returned by the conditional update, so a concurrent
claim cannot leave a stale attempt count in history. Public cancellation
retains the normal ambient-tenant check; explicit system context remains the
operator bypass.

```typescript
const events = await SmrtJobEventCollection.create({ db });
const page = await events.listTerminalOutcomes({
  tenantId,
  queues: ['reports'],
  objectTypes: ['SmrtDataSurfaceActionTask'],
  methods: ['run'],
  limit: 100,
});
```

The explicit tenant boundary is required; pass `tenantId: null` only for global
jobs. Results are newest-first and expose job ID, terminal status, queue,
object type, method, attempt count, completion time, cursor, and the bounded
failure class `execution`, `timeout`, or `stale-recovery`. They never expose
arguments, object IDs, results, raw errors, or stacks. Reads inspect at most
1,000 candidates per page and follow job-event retention (30 days by default).
Applications must still authorize each job ID against their own durable
ownership record before displaying it.

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
| `SmrtJobEventCollection` | Durable telemetry plus explicit-tenant `listTerminalOutcomes()` safe projection |
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
| `createHmacDurableJobPayloadSigner({ keyId, key })` | Sign canonical JSON job payloads with a server-only key and verify them after persistence |

### Key Types

`Priority`, `JobStatus`, `JobResult`, `WaitOptions`, `BgOptions`, `BackgroundCapable`, `TaskRunnerConfig`, `TaskRunnerEvents`, `ScheduleRunnerConfig`, `ScheduleRunnerEvents`, `ScheduleInfo`, `JobContext`, `TimeoutBehavior`, `SmrtJobData`, `ListReadyOptions`, `DurableJobPayloadSigner`, `DurableJobPayloadIntegrity`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-types` -- shared type definitions
- `@happyvertical/jobs` -- retry strategies
- `@happyvertical/sql` -- database interface
- `@happyvertical/logger` -- structured logging
- `@happyvertical/utils` -- ID generation utilities
- Peer (optional): `@happyvertical/smrt-svelte`, `svelte`

### Restartable MCP input

For a workflow that must survive process restart, create the task with
`continuation: { recordId, revision, inputKey }`. These are immutable references
to an existing application review/action record, not approval or authority.
Create the store with both `ownerId` and `tenantId`; task creation must match
that active tenant. The application adapter must derive these values from its
verified principal, never tool arguments.

Configure `TaskRunner.authorizeMcpTask` to resolve live grants and validate the
bound actor/tenant against the owning record. It is mandatory for continuation tasks and for every remote app-created task,
and fails closed if absent or unavailable. Provider exceptions become the fixed
`MCP task authorization denied` error before task persistence; internal provider
details are never exposed through task status. It runs before each invocation;
`context.task.assertAuthorized()` repeats it and checks worker ownership before
apply. A permission snapshot must not be persisted in the job.

`context.task.requestContinuation(binding, inputDescriptor)` stores one input
round in the existing job row and suspends execution, releasing the worker.
Waiting rows are not claimable until `updateTask()` atomically stores the first
complete answer. A new worker starts the method from its beginning and retrieves
the saved answer. Calls before this seam must be read-only or use the owning
`runOnce`/action idempotency contract. The binding cannot change between rounds;
use a new owning action/task for another review revision. JSON input is bounded
to 64 KiB. Unknown response keys are ignored, incomplete responses do not wake
the job, and repeated answers cannot overwrite the first accepted response.
Once an answer is accepted, status is `working` while queued or resumed; the
immutable response remains available for replay without asking for input again.

`getContinuation(taskId)` exposes the waiting descriptor only through the same
actor/tenant-scoped store. Use it in an explicitly declared authorized workflow
tool or application form. It adds no fields to MCP `tasks/get`. The stateless
HTTP adapter retains no callback; absent elicitation, offer the application's
review URL/form. OpenAI MRTR is an optional protocol adapter responsibility and
is not implemented by this job API. The legacy `requestInput()` remains a
running-handler wait bounded by the job timeout and is not restartable.

Continuation tasks and remote app-created tasks do not automatically retry errors or unknown external outcomes.
Reconcile those through the owning action state's durable reservation/evidence
API; never blindly resubmit. Cancellation guards subsequent cooperative work
and terminal writes, but cannot retract an external side effect already sent.
The owning apply transaction must revalidate immutable review/revision and
idempotency. A host answer never creates final human approval; Iolaus continues
to use its dedicated human review page.

Persistence checks: `pnpm --filter @happyvertical/smrt-jobs test` and
`pnpm --filter @happyvertical/smrt-jobs test:postgres`. The continuation suite
also runs against a managed PostgreSQL database with:

```sh
node scripts/run-with-ci-postgres.mjs -- pnpm --filter @happyvertical/smrt-jobs test src/__tests__/mcp-continuation.optional.test.ts
```

Supply `CI_POSTGRES_BASE_URL` for a disposable test server; the wrapper creates
and drops a synthetic database. Do not point destructive fixtures at user data.

Generated stdio servers retain their existing trusted-local-process assumption:
`SMRT_MCP_TENANT_ID` is a deployment scope and existing task owner namespace,
not an authenticated human identity. The generated store now also passes the
same active tenant used by task creation. Multi-user remote workflows require
the verified application principal path and a live runner authorizer.

The app integration exports `continueMcpWorkflow()` and
`createMcpContinuationTool()` from `@happyvertical/smrt-app-mcp`.
The first composes this job seam with an application's `applyReviewed` callback;
that callback must invoke its owning immutable approval and idempotency API,
not a raw mutation. The second declares a read-only workflow tool for a host
without elicitation. Register that tool through the app server's existing
`workflowTools` option. Supply a `storeFor(verifiedPrincipal)` bound to the same
owner namespace and tenant used for task creation, and a live `authorize`
callback. It returns text and structured form/review URL data; no iframe,
subscription, or host-specific form implementation is required. Review URLs
must use HTTPS, or HTTP on loopback for a local deployment, without credentials.


Remote `createMcpAppServer` task stores always set `requireAuthorization: true`.
This server-owned requirement is persisted separately from user invocation
arguments; tool arguments cannot disable it. An ordinary remote task without
continuation metadata must therefore configure the same live worker callback.
The legacy input seam also checks current authority before waiting and after
input returns. Applications must call `context.task.assertAuthorized()` again
immediately before later side effects. Direct `McpTaskStore` callers default to
trusted-local compatibility; set `requireAuthorization: true` for any remote
or multi-user application. This default does not confer human identity.

Shutdown includes any in-flight claim in the existing bounded drain and keeps
the worker lease until that drain finishes. A claim returning after shutdown
started is released without dispatch or consuming an attempt, even if the
shutdown deadline has elapsed; the next incarnation may claim it normally.
The same runner cannot restart while an earlier poll or handler is still draining.

### Durable continuation ready-index rollout

`_smrt_jobs_ready_idx` is an additive declared nonunique index on `(status,
run_at)`, restricted to `status = 'pending' AND (task_input_requests IS NULL
OR task_input_responses IS NOT NULL)`. Both `listReady()` and `claimReady()`
use this exact eligibility predicate. Suspended already-due jobs remain pending,
but SQLite/PostgreSQL exclude them from this index until an answer wakes them.
The original `_smrt_jobs_status_run_at_idx` remains for other status/time reads.

Deploy through the owning schema migration path: run `smrt db:migrate` before
running the updated workers; for continuously written PostgreSQL queues use
`smrt db:migrate --postgres-safe` so the index builds concurrently. No runtime
task/runner API creates the index. The old schema remains functionally correct
until migration, but polling can scan the suspended backlog. This changes no
column or task status. DuckDB/JSON use the existing DDL strategy's full-index
fallback and do **not** gain suspended-backlog exclusion; the readiness filter
still preserves correctness on those engines.

Task creation snapshots only validated `recordId`, `revision`, and `inputKey`
values before any awaited enqueue work. Extra caller fields are not persisted,
and later mutation of the caller's binding cannot change the durable review
reference. Live authorization still checks the saved reference at execution
and resume; the snapshot never grants approval.
