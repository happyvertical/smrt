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
   and attempt. The judged event of the attempt is the last `call` or
   `handoff` event it added (a fusion answers through a child run and a
   `handoff`).
4. Schema errors, unreadable JSON and `AiCallLimitError` are repairable
   attempts; past `budget.repairRetries` the run fails `repairs_exhausted`.
5. The check: `failure` → `check` failed, run `failed`/`check_failed`;
   `waitingApproval` → `approval` requested, run `waiting-approval`;
   `repeat` → `check` failed, step again up to `maxRepeats`; `complete` →
   `check` passed, run `done`; otherwise `check` passed, next step.

`decide` appends the decision event (parent: the request) and resumes the run
(approved: the next `run` re-runs the check with `approval: 'approved'`) or
fails it (`check_failed`). `stop` is `interrupted` (resumable); `cancel` is
final. `resume` passes the definition version, the app ceiling and the
reconciler to `resumeAiRun`; a budget stop needs the stopping limit raised.
`retry` opens a new run with `retry_of_run_id`, carrying the failed run's
accepted outputs of completed steps; refusals are core's
`AiRunResumeRefusedError` reasons.

## Leases and fencing

With `holder`, `run` writes `{ holder, expiresAt }` to the checkpoint's
`lease` and renews it every third of `leaseTtlMs` through the same serialized
save path as the driver's own saves, on the driver's database handle (never a
second connection). A run refuses a second `run` or `resume` of the same run
in its process. Across processes, safety is claim fencing: pass
`workflowClaimFence(getJobClaim(context))` from a runner started with
`claimFencing: true`; every save, step start and reservation asserts it, and a
taken-over worker gets `AiRunClaimLostError` before it writes. Settlements do
not assert it: spending that happened is counted.

## Job target (open)

The TaskRunner resolves a job's `objectType` through the registry and
hydrates `objectId` by `id` from the class's table. A `SmrtObject` declared
over `_smrt_ai_run_checkpoints` cannot be hydrated (the table has `run_id`,
no `id`), and any registered model is a migrate-managed table. The job bridge
needs a decision before it lands here: an owned model table for the job
target, or a jobs dispatch that is not bound to a model.
