# @happyvertical/smrt-workflows

Durable workflow runs for s-m-r-t. A host defines an ordered list of steps; each
step names a registered prompt, a JSON Schema for its output and an optional
check. The driver runs them as one `workflow` run on smrt-core's run records
(see the [AI runs concepts page](../../docs/content/ai-runs.md)):

- every step call resolves its prompt through `resolvePrompt` and goes out on
  core's tracked client inside the run, so it is reserved against the run's
  budget and recorded as a `call` event and a usage row carrying the step, the
  attempt and the prompt's template hash;
- output that fails the schema is repaired (attempt 2, 3, ...) up to the
  budget's `repairRetries`, then the run fails with `repairs_exhausted`;
- accepted output goes to the host check, recorded as a `check` event; a check
  may reject it (`check_failed`), ask for the step again, finish the run early
  or pause it for a person's approval (`approval` events, one hold per
  gated action; a step passes only with no hold outstanding);
- a budget limit, a stop or a child run's stop leaves the run `stopped` with a
  typed reason and resumable; a cancel ends it for good; a failed run can be
  retried from its last accepted step as a new run.

## Installation

```bash
pnpm add @happyvertical/smrt-workflows
```

Run the application's migrations first. The package creates no tables: runs,
events and checkpoints live in core's system tables.

## Usage

```ts
import { createTrackedAiClient } from '@happyvertical/smrt-core';
import { definePrompt } from '@happyvertical/smrt-prompts';
import { createWorkflowRunDriver } from '@happyvertical/smrt-workflows';

definePrompt({ key: 'kitchen.propose', template: 'Propose a layout for {input}.' });

const driver = createWorkflowRunDriver({
  ai: createTrackedAiClient({ db, tenantId }),
  definition: {
    key: 'kitchen-design',
    version: '1',
    steps: [
      {
        name: 'Propose',
        promptKey: 'kitchen.propose',
        schema: layoutSchema,
        check: async (output) => (fits(output) ? {} : { repeat: true }),
        maxRepeats: 2,
      },
    ],
  },
  validate: (schema, output) => ajvErrors(schema, output),
});

const run = await driver.start({
  ownerId,
  input: { room: 'kitchen' },
  budget: { maxTokens: 200_000, maxSteps: 4, repairRetries: 1 },
});
// From the background job that holds the run, with its signal and claim:
await driver.run(run.id, ownerId, { signal, fence: workflowClaimFence(claim) });
```

`get`, `stop`, `cancel`, `resume` (raise a limit after a budget stop), `decide`
(a person's approval decision) and `retry` complete the API. Large input is
passed by reference: start with `inputRef` and supply `readInput`.

## Running from background jobs

`createWorkflowRunJobs` is the job bridge. It registers the named job handler
`@happyvertical/smrt-workflows:workflow-run`, admits one handler job per run
(`enqueueHandlerJob`, the run id in its payload) and works the run inside it
with claim fencing and a lease renewed while it works:

```ts
import { createTrackedAiClient } from '@happyvertical/smrt-core';
import { TaskRunner } from '@happyvertical/smrt-jobs';
import { createWorkflowRunJobs } from '@happyvertical/smrt-workflows';

// At startup, before any runner starts.
const workflows = createWorkflowRunJobs<{ room: string }>({
  db,
  definition,
  authorize: async (owner) => assertMayDesign(owner),
  configure: (owner) => ({
    ai: createTrackedAiClient({ db, tenantId: owner.tenantId }),
    validate: (schema, output) => ajvErrors(schema, output),
  }),
});
const runner = new TaskRunner({ claimFencing: true });
await runner.initialize(db);
await runner.start();

const mine = workflows.forOwner(ownerId, tenantId);
const run = await mine.start({ key: 'request-1', input: { room: 'kitchen' } });
```

- `start` is idempotent per key and request (the same key with another
  request throws `WorkflowRunKeyConflictError`); `get`, `stop`, `cancel`,
  `resume`, `decide`, `continueAfterApproval` and `retry` follow the driver's.
  A stopped run resumes by admitting a new job; a run that waits for approval
  holds no job, and `decide` admits one.
- Register before claiming: creating a host (or calling
  `registerWorkflowRunHandler()`) after a `TaskRunner` started throws
  `JobHandlerRegistrationClosedError`. Create a host for every definition a
  worker consumes; a worker without one fails the job and the run is stopped
  or failed on the next read (see [workflow runs](agents/workflow-runs.md)).
- Steps, checks and prompts must be safe to repeat: after a crash a second
  worker repeats the step that was in flight. Recover with `resume(runId)`
  once the job runner has recovered the dead worker's job.
- A pending job with no worker stays pending until a worker runs it.

## Validation

Run the package `build`, `typecheck` and `test`. Tests run on in-process
SQLite, DuckDB and PGlite with a scripted model; the PostgreSQL lane runs when
`SMRT_TEST_POSTGRES_URL` is set.
