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

Dispatch fencing also compares the captured `startedAt`. `claimReady` only
claims at a timestamp strictly greater than the row's previous `started_at`;
retry and surplus release preserve that value. Millisecond resolution is safe
because equal/backward clock readings leave the row pending until time advances,
rather than creating a second dispatch with the same generation. Pending jobs
may therefore retain their last dispatch start. No new column is required.

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
