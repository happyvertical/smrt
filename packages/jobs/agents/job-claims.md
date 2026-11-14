# Jobs claim and recovery contracts

## Transaction-bound claim proof

`getJobClaim(context)` returns an immutable dispatch-time identity from an
actual TaskRunner context (never infer its worker from a later row read).
`assertJobClaim(tx, claim)` locks and proves the same running job, worker,
attempt, tenant and target before application writes in that transaction.
`assertJobClaimForRelease(tx, claim)` also accepts the same terminal attempt,
allowing a settled handler to clear its application's lease after Stop. It
rejects pending, recovered and replacement claims. Neither function changes
job status nor expires the process lease. Return from the handler to park;
TaskRunner owns job completion. Use only after current host authorization.

Dispatch fencing is opt-in: start `TaskRunner` with `claimFencing: true` to
use `getJobClaim`. Defaults retain their previous terminal/retry behavior and
claim timing. Public `retry()` and surplus release clear `started_at` as before.
The opted-in runner uses `max(now, previousWorkerDispatch + 1ms)` for each claim
batch, reserved before SQL on its DB/worker incarnation. A frozen/backward clock
never delays ready work. This logical start may be ahead of wall time; catch-up
has no bounded wall duration after an arbitrary clock step and does not gate
scheduling. `runAt` eligibility still uses the normal host clock.

The generation clock belongs to the worker incarnation, not the job row, so
legacy retry/release clearing `started_at` cannot reuse an opted-in worker's
claim. A process restart uses a new worker key. Direct `claimReady` users that
opt into `claimFencing` must use one DB handle and a unique worker incarnation
per process, consistently enabling fencing for that incarnation. Never share
worker keys across independent runners or alternate fenced/unfenced claims.
No schema changes are required.

During rolling deployments, old runners retain their existing semantics and
cannot supply the new authentic claim proof. New fenced handlers reject an
unfenced context before doing application work. Route handlers requiring proofs
to a dedicated queue consumed only by opted-in upgraded runners, or upgrade all
consumers of that queue before admitting such jobs. Existing ordinary jobs need
no change. Timestamp clearing by old code is safe for new proofs: a replacement
worker key differs, and an opted-in original incarnation's clock still advances.

Use `assertFailedJobDispatch(tx, dispatch)` to lock an exact failed dispatch
before checkpoint recovery and re-admission. It checks tenant, target, attempt
and the retained start generation and rejects a concurrent retry/reclaim. Use
the same caller transaction for the domain CAS and job admission.

`SmrtJobEventCollection.getTerminalOutcome(jobId, { tenantId, attempts?,
completedAt? })` reads the safe outcome for that exact job and completion,
without depending on the tenant feed's 1,000 candidates. Event retention still
applies, and callers must authorize the resource as well as supply its tenant.


`assertAbandonedJobClaim(tx, claim)` permits an application lease release only
for its persisted exact terminal dispatch when the original worker is neither
in the process live set nor holding a fresh worker lease. It uses TaskRunner's
liveness contract, not an application's timeout. A cancelled row alone never
proves settlement. Keep the application lease CAS in that same transaction.


PGlite support is opt-in: call `enablePgliteJobs(db)` before creating jobs
collections or starting a runner. It enables PostgreSQL claim/event SQL and
main-loop liveness renewal for that shared SDK client (including transactions).
Merely exposing `dumpDataDir` does not change engine selection. Existing hosts
that do not call this API retain their previous behavior. The isolated fixture
regression is enabled with `SMRT_TEST_PGLITE_MODULE`; it is not a full PGlite
backend certification of the jobs suite.


Abandonment locks only the exact job row. Its process live-set and fresh-worker
lease reads are observations without a worker-row lock, matching TaskRunner
stale recovery. They do not serialize against a later lease renewal or prove
that an expired/suspended process has physically stopped. Keep domain writes
claim-fenced after re-admission and external effects idempotent; do not treat
this API as stronger process exclusion or physical cancellation.
