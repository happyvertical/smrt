# Workflow runs

## Lifecycle

`start` opens a durable `workflow` run through the tracked client
(`openRun`), with its first checkpoint, in one transaction; it fails with
`AiRunTrackingDisabledError` while usage tracking is off. `run` works it:

1. Reconciles reservations a dead worker left (`reconcileAiRunOnClaim`).
2. Checks the checkpoint's definition version. Another version stops the run
   with `definition_changed`, unless `definition.olderCheckpoints.accepts` it;
   then `migrate` returns the state in this version's shape and the save
   records the new version on the checkpoint and run row.
3. Per step: `startAiRunStep` with the checkpoint (counted once per step
   index against `maxSteps`; a re-entry or repeat gets a new step instance),
   then the call with an `AiRunContext` carrying step index, name, instance
   and attempt, and the prompt's call options (`promptMessageOptions`
   without tier keys: params, model, temperature, maxTokens, effort as
   `reasoning`). The judged event of the attempt is the last `call` or
   `handoff` event it added (a fusion answers through a child run and a
   `handoff`).
4. Schema errors, unreadable JSON and `AiCallLimitError` are repairable
   attempts; past `budget.repairRetries` the run fails `repairs_exhausted`.
5. The check: `failure` → `check` failed, run `failed`/`check_failed`;
   `waitingApproval` → a new `approval` requested (`payload_ref` from
   `holdRef`), run `waiting-approval`. Every `waitingApproval` is a new hold,
   also after an approval: a step gating several actions holds once per
   action, `approvals` (in the checkpoint and the check context) counts the
   ones approved, and the step passes only when its check returns without a
   hold, so a run never ends `done` with a hold outstanding;
   `repeat` → `check` failed, step again up to `maxRepeats`; `complete` →
   `check` passed, run `done`; otherwise `check` passed, next step.

`decide` appends the decision event (parent: the request); a run stopped while it waited keeps the decision and stays stopped until `resume`. Otherwise it resumes the run
(approved: the next `run` counts it, clears the outstanding hold and re-runs the check with `approval: 'approved'`) or
fails it (`check_failed`). `stop` is `interrupted` (resumable); `cancel` is
final. `resume` passes the definition version, the app ceiling and the
reconciler to `resumeAiRun`; a budget stop needs the stopping limit raised.
`retry` opens a new run with `retry_of_run_id`, carrying the failed run's
accepted outputs of completed steps; refusals are core's
`AiRunResumeRefusedError` reasons. Core treats another tenant's run as
absent (`retry_source_pruned`, as an unknown id); the driver itself refuses
only its own tenant's runs of another owner or definition
(`WorkflowRunNotFoundError`), judged from one read within its tenant; core
compares the owner again under the source lock (`not_retryable`). A retry
`id` that ever named a run is core's `AiRunIdUsedError`. The checkpoint
store reads a run and its checkpoint with core's scoped reads (tenant, owner
and run type are predicates of each statement); a run id names one run for
the database's lifetime, so between the reads it can only disappear.

## Leases and fencing

With `holder`, `run` writes `{ holder, expiresAt }` to the checkpoint's
`lease` and renews it every third of `leaseTtlMs` through the same serialized
save path as the driver's own saves, on the driver's database handle (never a
second connection). A run refuses a second `run` or `resume` of the same run
in its process. Across processes, safety is claim fencing: pass
`workflowClaimFence(getJobClaim(context))` from a runner started with
`claimFencing: true`; every save, step start, reservation, event and status
change (done, failed, waiting for approval) asserts it, and a taken-over
worker gets `AiRunClaimLostError` before it writes: it never fails, finishes or
stops the run the new worker holds. The stop written when the signal aborts
uses `stopFence` (default `fence`): `workflowStopFence(claim)` accepts the
worker's own attempt after its job settled (cancelled, timed out) and refuses
a claim another worker took over, or a job a newer job of the run replaced
(stale recovery keeps the worker on its failed row). It locks the run's
chain root first, down to the run (the accounting lock order, so it never
deadlocks with a settle on the same chain), before it looks for a newer job,
and `resume` changes the run's status and admits its new job in one
accounting transaction (`driver.resume`'s `admit`; retried as a whole on a
conflict) while holding that row, so a stale stop never lands between them
and stops the resumed run. Settlements do not assert it: spending that happened is counted.

## Job running (`src/jobs.ts`)

`createWorkflowRunJobs({ db, jobs?, definition, queue?, authorize?,
resumeBudget?, configure })` registers the handler
`@happyvertical/smrt-workflows:workflow-run` (a `smrt-jobs` named handler, no
model, no table) and returns `{ handler, dispose, forOwner(ownerId, tenantId) }`.
`forOwner` has `start`, `get`, `stop`, `cancel`, `resume`, `decide`,
`continueAfterApproval` and `retry`. `configure(owner, input)` rebuilds the
driver wiring on every job (after a restart nothing lives in a closure); its
`ai` must be the owner's tenant on the same `db`.

- **Registration before claim.** The jobs registry closes at
  `TaskRunner.start()`. Creating a host calls `registerWorkflowRunHandler()`,
  which unregisters and registers the handler (both throw
  `JobHandlerRegistrationClosedError` while a runner runs, before changing
  anything), so a late host of any definition fails loudly and leaves no route
  behind. One handler serves every definition in the process: the payload's
  `definition` key picks the host; a duplicate key throws. `dispose()` of the
  last host unregisters the handler, so stop runners first.
- **Admission.** `start` derives the run id from definition key, owner,
  tenant and `key`, stores a digest of the request in the run's tags, opens the
  run and enqueues `enqueueHandlerJob({ handler, payload: { runId, definition
  }, dedupeKey: runId, maxAttempts: 1 })`. Run and job are not one
  transaction: a repeated `start` with the same key admits the job a crash lost.
  Once retention has removed the key's run, its id stays reserved, so `start`
  with that key throws `WorkflowRunKeyExpiredError` for any request
  (`WorkflowRunKeyConflictError` means the run is kept and the request
  differs).
  A pending job row with no worker stays pending until a worker runs.
- **The handler** requires an authentic runner context and a claim
  (`claimFencing: true`), reads owner and tenant from the run row (never the
  payload), checks the claim's target, `authorize`s, then `driver.run` with
  `fence: workflowClaimFence(claim)`, `stopFence: workflowStopFence(claim)`,
  the job's signal and
  `holder: workerId:jobId`; the driver renews the checkpoint lease every third
  of `leaseTtlMs`. A failure before the driver began (authorization,
  configuration, missing definition) stops the run (`interrupted`, resumable)
  while the claim is live and fails the job; a failure inside the driver is the
  driver's (`failed` / `error`). `AiRunClaimLostError` propagates and writes
  nothing.
- **Job ends, run follows** (read by `get` and `resume`): a cancelled job with
  the run still `running` cancels the run; a job failed with any kind but
  stale recovery fails it (`error`); `handler-unregistered` and
  `handler-unclaimed` stop it (resumable once a worker registers the
  handler). Stale recovery (the worker
  died) leaves the run `running`: `resume(runId)` then proves the dead
  dispatch (`assertFailedJobDispatch`) and admits a new job in one
  transaction; the second worker's `reconcileAiRunOnClaim` returns what the
  first reserved. Actions (`execute`, `check`, host effects) are therefore
  at-least-once and must be safe to repeat.
- **Resume, approval, retry.** A stopped run resumes with `resumeBudget` as
  the host's cap; its new job is admitted in the same transaction. A run at an approval holds no job: `decide`
  waits for the parking job to settle, records the decision and, when
  approved, admits a job that re-runs the check; `continueAfterApproval` does
  the same for a decision recorded elsewhere, and is harmless to repeat.
  `retry` opens the new run and admits its job.
- **Mixed fleets.** A runner claims a workflow run's job only when its
  process registered the workflow-run handler; a job no such runner claims
  within `handlerUnclaimedDeadlineMs` (default 24 h) fails
  `handler-unclaimed` and the run stops, resumable. A worker that registered
  the handler but created no host for the job's definition still fails that
  job (the run is then failed on the next read), so create every
  definition's host in each process that registers the handler, or give
  definitions their own queues. Upgrade every runner before enqueueing.

## Host effects during a check

`WorkflowCheckContext.assertActive()` checks the abort signal, job claim and
running status through the driver's serialized accounting transaction. Call it
before each host effect in a long check. It throws `AiRunClaimLostError` for a
taken-over worker and `AiRunStoppedError` after a stop/cancel or active-duration budget stop. The assertion is
a boundary check, not a transaction spanning another database: effects must
still be safe to repeat and isolated by their host's durable identity.

Checks may return `diagnostics: {code,path,message}[]`. The host's `validate`
callback may return these objects alongside existing string errors. Structured
issues are recorded on failed schema checks and host checks, linked to the
judged call/handoff. At most 20 issues are kept (code 80, path 300, message
1000 characters, 8 KiB total); repair input receives the same bounded details. An optional
`repair` hint (4000 characters) is checkpoint/model-only, excluded from events. Hosts must
supply safe validation text, never credentials or source data/fragments.
