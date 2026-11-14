# @happyvertical/smrt-design-runs

smrt's server-side bridge for running inference design runs as background jobs.
Inference owns ordered passes, validation, bounded repair, budgets and durable
checkpoints. Jobs owns admission, claims, cancellation and worker recovery. This
package joins those APIs without product schemas, UI or additional tables.

## Installation

```bash
pnpm add @happyvertical/smrt-design-runs
```

Run the application's normal migrations for the existing inference and jobs
models before boot. The package never creates application schema.

## Usage

The host supplies a full JSON Schema validator (such as Ajv), its pass executor,
resource reader, deterministic checks and current owner authorization:

```ts
import { createDesignRunJobs } from '@happyvertical/smrt-design-runs';
import { TaskRunner } from '@happyvertical/smrt-jobs';

const designs = createDesignRunJobs<{ prompt: string }, { value: number }>({
  db,
  jobs,
  kind: 'example-design',
  definition: 'example/v1',
  authorize,
  configure: () => ({ passes, validate, executePass, readResource }),
});
// The host runner must opt into dispatch fencing.
const runner = new TaskRunner({ claimFencing: true });
const dispose = designs.install(); // before starting the host's TaskRunner
const owner = designs.forOwner(ownerId, tenantId); // authenticated host values
const run = await owner.start({
  key: requestKey,
  input: { prompt: 'Design it' },
  budget,
});
const state = await owner.get(run.id);
// On shutdown: stop the host's TaskRunner, then dispose().
```

The two-pass integration test exercises this example with real SQLite, TaskRunner
and Ajv. Execution produces typed `input` and `outputs` snapshots; mandatory
host schema validation establishes the output contract. `configure` runs again
from persisted input after restart; do not rely on request-local state. Checks
may replace input, so keep its shape compatible with the host's input type.

`start` is idempotent for a key scoped to kind, owner and tenant, including after
completion. Reusing a key with an identical JSON request returns the same run. Different
input, resources or initial budget throws `DesignRunKeyConflictError`; choose a
new key for new work. The insert CAS and deduplicated job enqueue commit together. A host
must keep a definition stable for an admitted key, or version its kind as well.

`handler(record, args, context)` is the runner bridge. `install()` connects it to
inference's single executor slot per database. Several factory instances share one installed executor and route by the host's
`kind`. Each teardown removes only that instance's kind; the last removes the
executor. Duplicate kind registration is rejected. The host must enable `claimFencing: true` on every runner consuming these jobs;
use a dedicated queue during a rolling upgrade. No second runner is created here.

## Stop, cancellation and continuation

Owner bindings expose `start`, `get`, `stop`, `cancel`, `resume` and
`continueAfterApproval`. Stop persists the driver's stopped checkpoint, cancels
pending/running backing jobs and forwards cooperative abort to an in-flight pass.
A lease is released only after that pass/check's original promise truly settles.
An engine that ignores its signal prevents overlapping resume.

**Terminal cancellation is not yet available; it is tracked in issue #4995.**
`cancel` delegates to inference's current resumable Stop behavior. It does not
invent a cancelled run status. Validation repairs exhausted produce `failed`;
budgets produce resumable `stopped`. Parked or failed domain runs return normally
from their handler so their backing job completes rather than retrying forever.

An approval check returns `waitingApproval`. Once its job completes, the host
records approval or rejection durably through its own approval service and calls
`continueAfterApproval`. That re-admits the same check without another model
call for the accepted output. The check enforces the recorded decision; this
package grants no approval authority or application permissions.

A crashed worker's orphaned job becomes `failed` with an authoritative
`stale-recovery` event. It is not automatically requeued. After recovery, the
host calls `resume`; checkpoint CAS and re-admission commit together without
clearing the retained inference lease. Only the new legitimate job claim may
replay the interrupted step. Already committed model passes are not repeated;
checks may replay, so application effects must have stable idempotency identities.
A live job, ordinary failure or missing job is insufficient recovery proof.
Budgets reserved by a crashed call remain charged. Recover first without a budget
override; if it stops for budget, raise totals on the subsequent resume. Stopped orphan leases carry private dispatch provenance. Resume uses jobs'
exact abandoned-terminal-claim proof before the public inference lease-release
CAS, then performs ordinary admission. Live processes and fresh worker leases
continue to block overlap; cancellation or a call timeout alone never suffices.
Legacy stopped leases without dispatch provenance fail closed and require
operator inspection. No inference API or schema change is required.

## Validation

Run package `build`, `typecheck` and `test`. The suite uses a real job runner and
SQLite, covering repair, budgets, approval decisions, abort, restart recovery,
claim fencing, idempotent admission and a runtime entry graph with no Svelte/UI.

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

Every worker lease acquisition records its authentic dispatch claim as private
checkpoint metadata. Inference's public `releaseLease` hook may release a
stopped orphan only after `assertAbandonedJobClaim` proves that exact terminal
claim's process dead under jobs' liveness contract. A newer inference lease
revision or job dispatch rejects the release. Metadata is omitted from public
snapshots; legacy leases lacking provenance remain blocked rather than guessed.
