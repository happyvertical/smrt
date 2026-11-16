# Cookbook workflow runs

`host/workflow-runs.ts` (`createCookbookWorkflowRuns`) is the cookbook host's
change workflow on `@happyvertical/smrt-workflows` (#4994; concepts:
[AI runs](../../../docs/content/ai-runs.md)). It owns only the cookbook
definition, its step prompt, schema and check; the driver, checkpoints, job
handler, leases, claim fencing, stop/resume and approvals are the package's.
Runs, checkpoints and events live in core's `_smrt_ai_*` system tables; the
host creates no schema and runs no SQL on them.

## Definition

- Key `cookbook-host.change`, version `1/steps-<n>`: one definition per host,
  `n` from `workflowBudget.steps` (default 4). A run resumes only under the
  step count that started it (`definition_changed` otherwise).
- Step 1 `Propose the change`, steps 2..n `Check and revise the change`. Every
  step sends the registered prompt `cookbook-host.change.step`
  (`cookbookChangeStepPrompt`, resolved with `resolvePrompt` for each attempt:
  request, step, stage, the pinned schema, earlier outputs and any repair).
- Each step's `execute` runs an internal assistant turn through the host's
  authenticated chat route (`executeStep` in `host/server.ts`): the turn's run
  is a child of the workflow run (chat's internal turn `step`), so its calls
  count in the workflow's totals and budget, a workflow stop/limit/cancel
  reaches it, and its usage rows carry the step prompt's key and hash. The
  turn gets read-only tools only, the run's pinned execution (engine, tier,
  model, effort) and the original permission ceiling intersected with live
  permissions. A turn that ended because the run stopped is the run's stop,
  never a failed step. An external CLI engine's turn opens no run in chat, so
  its step records no calls.
- Output is validated (Ajv, strict) against the schema pinned at start: the
  output envelope (`summary`, `checks`, `ready`, `operations`, bounded
  `personSummary`) with `oneOf` the live owner's structural tool schemas
  (`approvalId` removed). Invalid output is repaired on the same step up to
  `repairRetries`. Every execute and check re-derives the live schema and
  refuses a changed one (`The change schema changed`).

## Check (host-owned)

- The last step, or an adaptive first step (no explicit step count, a ready
  proposal of additive scalar/choice/money fields, field rename/hide or list
  label rename on one existing list, matched exactly against the bounded
  `app.describe` catalog pinned at start), applies the proposal through the
  core cookbook service with `workflowAction { application, runId, actionId }`.
- Each `approval_required` result is a hold: the check returns
  `waitingApproval` with `holdRef: approval:<id>`; the run waits. One hold per
  gated action; the step passes only when every action applied
  (smrt-workflows counts the approved holds; a run never ends `done` with a
  hold outstanding). Re-running the check after approval replays the held
  action once through core's stable action identity.
- An unready final proposal fails the run (`check_failed`) with the host's
  fixed note; a pre-effect `collision`/`clarification_required` before the
  last step expands the work; any other non-ok result throws.
- Every other step passes and marks the work expanded.

## Host surface

`host.workflowRuns.forOwner(ownerId, tenantId)`: `start`, `latest(threadId)`
(newest of the owner's last 100 runs, by the run's `threadId` tag), `get`,
`present` (wire progress: `{ runId, step: { index, count, name }, status,
note }`, fixed notes, `checking` while a check runs), `validateAction`,
`stop`, `resume`, `settleHold`.

- Routes: `GET /api/assistant/runs?threadId=`, `POST /api/assistant/runs`
  (`{ threadId, content }` only, same origin, thread ownership through chat's
  own read), `POST /api/assistant/runs/:id/stop|resume`. Errors are a generic
  409 `workflow_run_unavailable`.
- Native decisions: after the approval decide route (and on status reads and
  owner recovery) `settleHold` carries the hold's outcome into the run:
  approved, executing or succeeded → approve (the check re-runs); denied,
  failed or expired → refuse (`check_failed`). A run stopped while waiting
  keeps the decision; the cookbook continuation defers executing the hold
  while the run is stopped, and explicit Resume applies it once.
- Resume raises token/time limits to the app's current budget (never above
  it); a budget stop needs the stopping limit raised (else 409). A run whose
  worker died (its job failed with `stale-recovery`) is recovered by Resume.
- Registration: `createCookbookWorkflowRuns` registers the smrt-workflows
  handler, so the host creates it before `TaskRunner.start()` (afterwards it
  throws `JobHandlerRegistrationClosedError`). The runner uses
  `claimFencing: true`. Shutdown stops the runner, then disposes.

## SQLite note (#5022)

The local runtime opens the app file through more than one `node:sqlite`
connection. Run writes go through core's run API, which serializes them in
process with the chat route's writes; a raw transaction on a second handle
that overlaps a held write stalls the event loop for the busy timeout and
fails (`database is locked`). The fix belongs in the framework (#5022).

## Tests

`__tests__/cookbookWorkflowRuns.test.ts` (in-process SQLite, real TaskRunner
with claim fencing, scripted step): admission before execution, owner
isolation, three checked steps on the registered prompt with the pinned
schema, repair, an unready final proposal, cooperative stop and resume, a
changed live schema, registration after runner start.
`__tests__/cookbookHost.test.ts` covers the routes: run status by thread,
native approval holds (preview on/off, destructive, denied, several holds of
one proposal), approval while stopped then Resume, budget stop and resume,
schema repair without effects, and crash recovery with a second real runner
whose claim fencing refuses the dead worker's late save.
`__tests__/onboardingWriteThrough.test.ts` (mechanic, `workflow`) runs a
three-step workflow run with the native approval POST over the real runtime.
