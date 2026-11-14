# @happyvertical/smrt-design-runs

smrt's server-side bridge for running inference design runs as background jobs.
Inference owns ordered passes, validation, bounded repair, budgets and durable
checkpoints. Jobs owns admission, claims, cancellation and worker recovery. This
package joins those APIs without product schemas, UI or additional tables.

The intended consumers are the cookbook host and the app shell's workbook import
flow. Their migrations are separate work; neither consumer is changed here.

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

const designs = createDesignRunJobs<{ prompt: string }, { value: number }>({
  db,
  jobs,
  kind: 'example-design',
  definition: 'example/v1',
  authorize,
  configure: () => ({ passes, validate, executePass, readResource }),
});
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
completion. Reusing a key returns its original run and input; choose a new key for
new work. The insert CAS and deduplicated job enqueue commit together. A host
must keep a definition stable for an admitted key, or version its kind as well.

`handler(record, args, context)` is the runner bridge. `install()` connects it to
inference's single executor slot per database. Hosts using several kinds install
one `installDesignRunExecutor` router themselves and route `args.kind` to the
appropriate handler. No second runner is created here.

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
override; if it stops for budget, raise totals on the subsequent resume. Stopped runs whose original
process died with an unsettled lease require a future owning-package recovery
API; this bridge does not infer safety from elapsed time.

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

## Validation

Run package `build`, `typecheck` and `test`. The suite uses a real job runner and
SQLite, covering repair, budgets, approval decisions, abort, restart recovery,
claim fencing, idempotent admission and a runtime entry graph with no Svelte/UI.
