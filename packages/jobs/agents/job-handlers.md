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

## Outcomes

Handler jobs share the model path for MCP authority (checked first, so a
handler cannot bypass it), tenant context, timeout, cancellation, claim
fencing, retries and every terminal write. Differences:

- Unregistered on the claiming runner: `JobHandlerUnregisteredError`
  (`retryable: false`) ends the job `failed` on that claim whatever its
  `maxAttempts`, failure kind `handler-unregistered`, with its terminal event.
- A non-canonical `handler:` row (wrong method, an object id, an MCP task
  id, owner or marker), written past `enqueueJob`, fails
  terminally (`JobHandlerTargetError`, kind `execution`) after the authority
  check, without running a handler. MCP tasks target model methods only.
- Schedules cannot target handlers: a schedule naming one is set to
  `status = 'error'`.

## Mixed fleets (known limitation)

Claims do not filter by target. A runner that never registered a handler
fails its jobs as `handler-unregistered`; a runner older than #5005 treats
`handler:<name>` as an unknown model (`Unknown object type`, kind
`execution`) and retries it up to `maxAttempts` (clamped to 25) before
failing it. A pre-#5005 outcome reader also drops events with kind
`handler-unregistered`. Route handler jobs to a queue consumed only by
runners that register those handlers, and upgrade every consumer of that
queue first.
