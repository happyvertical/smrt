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
running handler must observe `context.signal` (an `AbortSignal` that aborts on
cancellation, or on a `'fail'`/`'kill'` timeout) before doing further side effects.

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

The `ScheduleRunner` polls the `_smrt_agent_schedules` table for due cron entries and creates `SmrtJob` records for the `TaskRunner` to execute. Each schedule's cron is evaluated in its row's IANA `timezone` (default `UTC`, DST-correct), independent of the host `TZ`. Each comma-separated list term is matched separately, and a step (`*/n`, `a-b/n`, `a/n`) counts from the field minimum or the term's base, as in standard cron.

Upgrade note: rows that relied on the old behaviour shift. A row left at the default `timezone = 'UTC'` on a non-UTC host now fires in UTC, and day-of-month or month `*/n` now matches 1, 1+n, … (for example `0 0 */2 * *` runs on odd days) instead of counting from 0.

Admission rechecks the current row under a database lock, and enqueues the job
and advances `next_run` in one transaction. Multiple scheduler processes admit
one job per due occurrence. An enqueue failure rolls back the slot so the next
poll can retry. Pending jobs and delayed retries occupy `maxConcurrent` capacity.
TaskRunner owns job crash recovery; schedule reconciliation never independently
fails a worker-owned job.

The handler receives `_scheduledFor`, the original due slot as a UTC ISO instant.
This is **fire-once-forward**: after one overdue occurrence the runner arms the
next future cron time; it does not backfill every missed slot. Keep domain
request replay and current authorization in the handler. Reserved occurrence
arguments cannot be set in `method_args`.

Optional `agentTypes` and `tenantIds` limit selection, reconciliation and claim
(`[]` selects none); `queue` chooses the output queue (default `agents`). Use
exact scopes and a dedicated task-worker queue for an application-specific host.
Use the same optional `tenantIds` scope on `TaskRunner`: ready claims and orphan
recovery filter before changing ownership or terminal state, and recovery also
honors configured queues. Explicit empty scopes process nothing. A tenant-scoped
TaskRunner defaults to `retention: false`, because the normal retention sweep is
system-wide maintenance. Worker queue advertising remains queue-level and does
not assert per-tenant availability.

For handlers that require proof of admission, pass a trusted host
`occurrenceSigner` to ScheduleRunner and require its `occurrenceIntegrity`
capability. The runner signs the exact job ID, tenant, schedule, UTC period,
execution target and full args inside the enqueue transaction, saving reserved
`_scheduleAdmission` metadata before commit. `verifyScheduleAdmission(job, signer)`
fails closed on copied or changed job/period/tenant/args and missing signatures;
`getScheduleAdmissionPayload(job, keyId)` only builds the pure signature payload.
Unsigned legacy runners remain supported, so protected handlers must explicitly
verify the persisted row. Exact job retries preserve their signature. A trusted
keyring may retain old verification keys while minting with a current key; unknown
or retired keys deny. Signature verification complements current authority and
normal database claims/idempotency. See [the full admission integrity contract](agents/scheduling.md#exact-occurrence-integrity).

Stop the scheduler before draining the TaskRunner: `await scheduleRunner.stop()`
waits for its in-flight admission transaction.

`SmrtJobCollection.enqueueJob` also accepts a tenant-partitioned `dedupeKey`
(nonblank, at most 512 characters). Concurrent enqueues return the same
pending/running job unchanged. Once terminal, a new job may reserve the key;
retrying an older job refuses if a newer one reserves it. This prevents overlapping
nonterminal jobs for a caller-defined resource, rather than permanent request
replay. JavaScript timeout cannot preempt an orphan handler's side effects.
Use `{ transaction: tx }` as the second argument to join a caller-owned
transaction without nesting (required on DuckDB). Propagate failures and commit
or roll back that transaction. Run `smrt db:migrate` before upgrading workers:
the nullable job provenance field and package-owned `_smrt_job_dedupe_slots`
model are additive schema changes. Key slots retain one pointer per distinct key;
use stable resource keys rather than one-shot request tokens.

Keyed UUID tenant identities must use canonical lowercase hyphenated spelling,
including ambient context; alternate valid UUID spellings fail before writes.
Opaque non-UUID IDs retain exact case. `job.retry()` re-reads stored identity and
args, locks schedule→key→job, and enforces schedule capacity before resetting
lifecycle fields. It preserves args/signatures and refreshes the model revision.
Use `retry({ transaction: tx })` to join a caller transaction without nesting and
propagate failures/roll back. See the [retry capacity and lock-order contract](agents/scheduling.md#public-retry-capacity-and-lock-order).

Wire them together via events:

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
| `_smrt_job_dedupe_slots` | Tenant-partitioned nonterminal job-key serialization |
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

Protected schedules can require a durable exact queue/signing-key policy through
`methodArgs._scheduleAdmissionPolicy`. An unsigned/default runner leaves them
untouched and emits `schedule:blocked`; require the
`requiredOccurrenceIntegrity` capability before creating such schedules. See
[durable required admission](agents/scheduling.md#durable-required-admission-3346)
for the typed policy, authorized rotation and verification-key retention contract.
