# Job targets: model methods and named handlers (#5005)

A job targets **either** a model method (`objectType` = a registered class,
`method` = one of its methods; unchanged) **or** a handler registered under a
namespaced name. Nothing else.

## Contract

- `registerJobHandler(name, handler)`, `unregisterJobHandler(name)`,
  `listJobHandlers()`. Names are `<package>:<name>`: an npm package name, a
  colon, a lowercase kebab-case local name, optionally dotted
  (`@happyvertical/smrt-workflows:workflow-run`). A bad name throws
  `JobHandlerNameError`; a duplicate throws `JobHandlerAlreadyRegisteredError`.
- Handler: `(payload, context) => result`. `payload` is the job's JSON
  `args`; `context` is the same runner `JobExecutionContext` a model method
  gets (authentic, so `getJobClaim(context)` works under `claimFencing: true`),
  with `context.job.handler` naming the handler. There is no per-job lease
  hook: the lease is per worker and the runner renews it while handlers run.
- Enqueue: `SmrtJobCollection.enqueueHandlerJob({ handler, payload, ...job
  options })`. The handler need not be registered in the producer process.
  Tenancy, dedupe, cap, retry ceiling and transaction options are
  `enqueueJob`'s.

## Storage (no schema change)

A handler job is an ordinary `_smrt_jobs` row in a reserved canonical form:
`object_type = 'handler:<name>'`, `method = 'handle'`, `object_id = NULL`,
`args` = payload, no MCP task columns, no runner-owned `_mcpTask`,
`_agentConfig` or `_schedule*` keys. `enqueueJob` refuses any other
`handler:`-prefixed row. The prefix is checked before `ObjectRegistry`;
`handler:@…` is not a qualified class name, so it never resolves to a model.
Claims, indexes, terminal events, `JobClaim`, `assertJobClaim`,
`assertFailedJobDispatch` and `assertAbandonedJobClaim` work on it unchanged.

## Registration before claim

`TaskRunner.start()` snapshots the registry and closes it before the first
claim; it reopens once every runner in the process has stopped. Registering
or unregistering while any runner runs throws
`JobHandlerRegistrationClosedError` naming the handler. A `start()` that
fails before claiming leaves it open. Register every handler at process
startup, before `runner.start()`. The registry is process-wide: re-evaluating
a registering module while a runner runs (HMR, a duplicate package instance)
throws.

## Claim filter

A runner claims model jobs and only the handler jobs it registered. The
claim adds one predicate inside the candidate select (before its `LIMIT`, so
rows a runner cannot run never fill its window):

```sql
NOT (substr(object_type, 1, 8) = 'handler:')
  OR object_type IN ('handler:<name>', …)  -- the start() snapshot
```

The prefix test is case-exact and wildcard-free on SQLite, PostgreSQL and
PGlite (SQLite `LIKE` is case-insensitive; `_` is a wildcard). With no
handler registered only the `NOT (…)` half is emitted, so the runner claims
no handler row. Model claims are unchanged and keep `_smrt_jobs_ready_idx`.
`claimReady({ handlerNames })` is the option; omitted, a direct caller's
claim does not filter by target. Each name is one bound parameter, so a
process may register at most `MAX_JOB_HANDLERS` (256) handlers
(`JobHandlerLimitError`); `claimReady` refuses more names (`RangeError`).

## Unclaimed deadline

A handler job still `pending` more than `handlerUnclaimedDeadlineMs` (runner
option, 1 ms to 10 years, default 24 h) after its `run_at` is failed with
failure kind `handler-unclaimed` and its terminal event; it never ran
(`attempts` as left). Every runner sweeps, from its poll, at most once per
1% of the deadline (between one lease tick and 15 min; about 14 min at the
default) and `HANDLER_UNCLAIMED_SWEEP_LIMIT` (100) rows per sweep (a full
batch sweeps again on the next poll), over its own queues and tenant scope,
leaving out the handlers it registered (`object_type NOT IN`, at most
`MAX_JOB_HANDLERS` bound parameters): it claims those, so an overdue backlog
it serves (a saturated queue, a fleet back after a day down) is run, not
failed. The runner emits `job:unclaimed` (not `job:failed`: it never
claimed the job) besides the persisted terminal event. Residual: while every
runner serving a handler is down past the deadline, a runner in the same
queue without that handler still fails its jobs; keep such runners out of
the queue, or raise the deadline, when that matters. `SmrtJob.retry()` on a handler job restarts its deadline (`run_at`
moves to now when it was in the past). Each row is one conditional
transition (`status = 'pending'` and `run_at` still past the cutoff), so
concurrent sweepers, a claim or a requeue win harmlessly: one event per job.
Model jobs are never swept. A queue no upgraded runner consumes is never
swept. With different deadlines in a fleet the shortest wins. A sweep
failure is a `runner:error`; the poll still claims.

## Outcomes

Handler jobs share the model path for MCP authority (checked first, so a
handler cannot bypass it), tenant context, timeout, cancellation, claim
fencing, retries and every terminal write. Differences:

- Unregistered on the claiming runner (a claim made without the filter; the
  backstop): `JobHandlerUnregisteredError` (`retryable: false`) ends the job
  `failed` on that claim whatever its `maxAttempts`, failure kind
  `handler-unregistered`, with its terminal event.
- Unclaimed past the deadline: failure kind `handler-unclaimed` (above).
- A non-canonical `handler:` row (wrong method, an object id, an MCP task
  id, owner or marker), written past `enqueueJob`, fails
  terminally (`JobHandlerTargetError`, kind `execution`) after the authority
  check, without running a handler. MCP tasks target model methods only.
- Schedules cannot target handlers: a schedule naming one is set to
  `status = 'error'`.

## Upgrade order (older runners)

A runner older than #5005 does not filter: it claims `handler:<name>` as an
unknown model (`Unknown object type`, kind `execution`), retries it up to
`maxAttempts` (clamped to 25), then fails it. An older outcome reader drops
events with kind `handler-unregistered` or `handler-unclaimed`. Do not
enqueue handler jobs until every runner and outcome reader on the database
is upgraded.
