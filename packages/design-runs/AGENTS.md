# smrt-design-runs

Server-only glue between inference's durable design driver/store and jobs'
TaskRunner. `src/index.ts` exports `createDesignRunJobs`, owner bindings,
snapshot/start/options types and informational `PACKAGE_NAME`. No models, tables,
UI, engine selection, product schemas or application effects belong here.

- Hosts supply `kind`, versioned `definition`, authorization and `configure`.
  Reconstruct passes and engine/resource adapters from durable input on restart.
- Start derives a UUID from kind/owner/tenant/key, then uses inference's insert
  CAS and transactional enqueue. Dedupe keys use that run ID, never package names.
- Job handlers accept authentic runner contexts only. Capture `getJobClaim` once;
  use jobs' public transaction-bound assertions for checkpoint and settled-lease
  release. No `_smrt_jobs` SQL here, including tests; mutate jobs through public
  APIs when simulating a stolen claim.
- `install()` shares one inference executor per DB and routes all installed
  kinds. Each teardown removes only its own kind; the last removes the executor.
  Duplicate kind registration rejects before replacing another handler.
- `forOwner` must use an authenticated principal. Authorization reruns on every
  operation and job invocation. Driver resource/check callbacks retain host policy.
- Cancel delegates to inference's resumable Stop (#4995), then cancels the backing
  job and signals local execution. A retained inference lease blocks resume until
  the original promise settles; never clear it merely because a timeout expired.
- Only authoritative `stale-recovery` of the exact failed job/attempt permits
  resume of a running/checking checkpoint with a retained lease. Checkpoint CAS
  and re-admission share a transaction; the replacement job claim authorizes replay.
- Hosts persist approval decisions using their own approval service, then call
  `continueAfterApproval`. Checks replay that decision; effects must be idempotent.

Validate with package `build`, `typecheck`, `test`. Tests use real TaskRunner and
in-process SQLite with fake pass execution and Ajv; no containers or model calls.

Early authorization/configuration/routing failures park lease-free checkpoints
as `stopped`, with a safe fixed explanation. Restore permissions/configuration,
then call `resume`; the backing failed job itself is not automatically retried.
Owner reads reconcile an authoritative routing failure if no handler started.
A retained lease fails closed instead of treating an early failure as proof of
settlement. Stop uses the public checkpoint CAS and never calls `configure`.

`continueAfterApproval` waits up to 30 seconds for a running parking job to
settle, then reloads the checkpoint. If it is no longer waiting, it returns
current status. Concurrent or repeated continuation calls do not duplicate
admission; the winner's current state is returned after a CAS conflict.

Admission stores a canonical digest of the original JSON request in checkpoint
metadata, independently of mutable pass input and resumed budgets. Object-key
order does not affect identity. Legacy checkpoints without this metadata fail
closed on replay because their original request cannot be verified. The digest
is private bridge metadata and is omitted from public snapshots.

Hosts may supply `resumeBudget(owner, state, proposed)` to return capped effective
totals or throw to refuse ordinary stopped/approval resume. It runs before any
checkpoint/admission write, and inference validates its returned budget. Without
the hook, behavior is unchanged. Crash recovery retains its existing totals;
raise them only on a subsequent budget-stop resume.

## Replaces in the cookbook host

The later migration can replace these regions of
[host/design-runs.ts](../template-sveltekit/host/design-runs.ts):

- `enqueue`: transactional job admission and dedupe configuration.
- `driver`: store construction, `authorizeWrite`, `authorizeRelease`,
  `ownsExecution` and common driver/job composition.
- `installDesignRunExecutor` bridge: authentic context/claim capture, target
  checks and abort-signal forwarding.
- `forOwner`: generic start/status/stop/resume and `resumeAfterApproval` plumbing,
  including verified stale-recovery re-admission.

Jobs' `getJobClaim` replaces the bridge's `SELECT worker_id` capture.
`assertJobClaim` replaces `authorizeWrite`'s conditional no-op update and
`ownsExecution`'s ownership SELECT. `assertJobClaimForRelease` replaces
`authorizeRelease`'s terminal-or-running conditional update. Host-specific
historical migrations still need their own migration policy and CAS.

The host retains schemas, pass/profile selection, owner/thread authorization,
approval decisions, effect replay, legacy migrations, latest-by-thread lookup,
proposal validation and presentation. `configure` adapts those existing callbacks.


Every worker lease acquisition records its authentic dispatch claim as private
checkpoint metadata. Inference's public `releaseLease` hook may release a
stopped orphan only after `assertAbandonedJobClaim` proves that exact terminal
claim's process dead under jobs' liveness contract. A newer inference lease
revision or job dispatch rejects the release. Metadata is omitted from public
snapshots; legacy leases lacking provenance remain blocked rather than guessed.
