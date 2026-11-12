# Durable design runs

`createDesignRunDriver` is an engine-neutral ordered pass executor. A run is a
workflow record in `_smrt_inference_design_runs`, not a second queue. Run normal
application migrations before starting it. The host admits work through existing
`SmrtJobCollection.enqueueJob` and executes it through `TaskRunner`; browser
connection lifetime must never own its cancellation signal.

The host binds `createDesignRunStore` to the authenticated owner and tenant. Its
`enqueue(transaction, state)` callback enqueues the existing job in that same
transaction, using the stable run id as `dedupeKey`. Start and resume either save
the checkpoint and admit the job together, or neither commits. Run ids are UUIDs.
All generated REST, CLI, and MCP surfaces on `DesignRunRecord` are disabled.

Install `installDesignRunExecutor(db, handler)` once when booting the host. Its
handler receives the hydrated record, arguments and runner context. Verify
`isRunnerExecutionContext`, the job target, tenant and current owner authority;
then build a worker store whose `authorizeWrite(transaction, state)` verifies the
live job claim on every checkpoint. Pass the runner's `signal` to `driver.run`.
Supply `ownsExecution` with that same live claim proof so a recovered job can
replace the crashed pass's stale lease immediately. Only `execute` is background-eligible. The installer returns teardown; reinstall
it after process restart before starting the runner.

A host definition pins a version string and an ordered list of plain-text pass
names and JSON schemas. Every engine, including CLI engines, returns an object
through `executePass`; the mandatory host `validate(schema, output)` callback
must use a full JSON Schema implementation such as Ajv, not a partial handwritten
validator. Invalid outputs and validation errors are checkpointed and supplied to
the next repair attempt. Repairs stop at `repairRetries`. Accepted outputs are
checkpointed before deterministic `check` code runs. Checks receive their own
abort signal, may feed facts to the next pass, request a bounded repeat, or pause
for owner approval. Checks must be read-only or idempotent because a crash may
replay them. A profile supplies quality and budgets, never permission or approval.

An approval hold retains the accepted output, current pass index and `check`
phase, clears repair state and releases the settled check lease. Resume reruns
that same check, including for the final pass; only a cleared check can advance
or finish the run. It never calls the model again for that accepted output or
duplicates its attempts/token usage. A denied check may fail terminally. Hosts
must give effects stable identities and recover their exact recorded result
when replay follows a crash after apply but before the completion checkpoint.
Recover a running/checking job by calling `run` under its legitimate replacement
TaskRunner claim (`ownsExecution`), without clearing leases through frontend
`resume`, weakening liveness proof or enabling generic failed-run retries.
For a definitive check rejection, the trusted host may return `failure` with
its own safe, static explanation. This ends the run as `failed`, retaining the
validated output, input, usage and attempts; it takes precedence over an approval
hold or repeat. Never copy model output or caught exception text into `failure`.
Ordinary thrown errors still receive the driver's generic failure explanation.

Inputs carry resource ids. `readResource` rejects ids outside the host's pinned
list; the host checks current owner access and supplies summary-first pages with
opaque cursors. A page exceeding `toolResultChars`, including its envelope, is
rejected before it enters model context. Files and credentials are never inlined
into checkpoints.

Token and elapsed-time allowances accumulate across model calls, repair calls,
and mechanical checks. Before each call, the driver durably reserves its entire
allowed token and time budget. Successful calls reconcile to reported actual
usage; unknown token usage or a crash retains the reservation conservatively.
Checks reserve time too. A timeout or exhausted cumulative budget produces a
resumable `stopped` run with a plain explanation. Raise total budgets on resume;
usage never resets. Stop is cooperative: cancel the existing job as well, and
forward its signal into engine requests. A still-active pass lease prevents
immediate overlapping resume. The worker store's `authorizeRelease` must lock
and prove the captured job id, worker id and attempt (running or its terminal
Stop outcome, never a pending/recovered claim). `releaseLease` freshly reads a
stopped checkpoint with the same `leaseRevision` and atomically clears that
lease with a revision CAS. The driver calls it only after the original engine
or check promise truly settles; winning an abort/timeout race alone cannot
release a lease. A retained `leaseRevision` blocks frontend resume even after
its deadline. Crash recovery of a running job requires `ownsExecution` from a
replacement TaskRunner claim; a stopped run whose original process died needs
an explicit host liveness recovery path, never an inference from elapsed time
or missing jobs. A cooperative stopped call can therefore resume immediately
when its backing job has also settled. Delayed release cannot clear a newer
running/resumed claim. CAS revisions prevent stale workers overwriting
Stop or newer progress. Definitive schema/check failures end as `failed`.

Progress uses exactly `{ runId, pass: { index, count, name }, status, note? }`.
Indices are one-based. Statuses are `running`, `checking`, `waiting-approval`,
`stopped`, `failed`, and `done`. Publish this on the existing event stream;
subscriber failures cannot interrupt durable work. Each attempt stores its
`WorkRunMetadata`, including actual provider usage when available. Host tool
policy, durable approvals and history apply throughout all passes.

## Reuse audit

The intent index, `review_smrt_project` and `build_context` were consulted before
implementation. Searches across smrt-ui, smrt-svelte, chat, core, jobs and inference
found no existing ordered schema-repair driver. Existing `SmrtJob`, `TaskRunner`,
`McpTaskStore` and durable MCP continuations remain the queue, liveness,
cancellation and input primitives. Job events have independent retention and do
not provide atomic workflow CAS, so a dedicated inference workflow checkpoint
holds pass inputs/outputs and cumulative budgets. Inference depends on no jobs
runtime; the authenticated host supplies the transaction admission callback.
