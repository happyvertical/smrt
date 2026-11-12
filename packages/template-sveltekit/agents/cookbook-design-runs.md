# Cookbook design runs

`host/design-runs.ts` composes inference's `createDesignRunDriver`,
`createDesignRunStore` and registered `DesignRunRecord.execute` with jobs'
`SmrtJobCollection` and the host's existing `TaskRunner`. It installs one executor
per database. Runtime migrations create the checkpoint and job tables; the
factory does not create schema. Dispose the executor after stopping the runner.
Jobs use one attempt: domain checkpoints own resume, so a stopped old invocation
cannot automatically reclaim its job while an external promise is still settling.

The authenticated host binds `forOwner(ownerId, tenantId)` from the live session.
`start` commits the checkpoint and job admission in one transaction before any
model executes. `status`, `latest(threadId)`, `stop` and `resume` keep the same
owner and tenant binding after a restart. `latest` considers the newest 100 owner
runs. Resume rejects while the prior job still runs, avoiding a dedupe race with
its terminal write; retry once the current pass has stopped.

The pinned design profile, original authenticated permission ceiling and
thread/request text are durable inputs, never a credential or captured Request.
Live permissions are intersected with that ceiling for every pass, so restart
cannot expand authority. Each pass reauthorizes the owner. A real
TaskRunner context and live job claim are required for execution, and checkpoint
writes recheck that claim. Request disconnects have no signal connection to the
worker. Stop aborts the local pass cooperatively and preserves its durable
checkpoint. Once the original model/check promise actually settles, a worker-only
transaction releases the stopped lease. Its no-op conditional update locks the
captured job, worker and attempt before the checkpoint CAS; a recovered or later
claim cannot release that lease. A cooperative Stop can resume immediately after
settlement, even with a long call deadline. An external engine that ignores
cancellation keeps its lease until actual settlement or the lease deadline; a new
process recovers through jobs' worker-liveness contract.

The default ordered passes understand the request, propose the design, then check
and revise it. The owner's pass count controls the number of passes; further
passes revise. Ajv validates every engine's JSON result against the same schema
(`summary`, `checks`, `ready`, `operations`), including repairs. Between passes deterministic
code rechecks schema and feeds the checked pass number and readiness into the
next input. This generic check establishes output structure, not application
schema correctness. Cookbook policy, revision checks and the existing apply
preview and approvals remain the authority for actual changes.

New runs pin `cookbook-design/v3/<passes>`. Their operation schema is a `oneOf`
of the current core cookbook structural tool names and input schemas, resolved
under the live owner. Approval ids are excluded from proposal arguments. The
model sees those exact schemas as proposal data while its callable tools remain
read-only; unknown tool names, MCP wire names and extra arguments enter the same
bounded schema repair path without effects. Persisted v1 runs retain their
original schema and review-pending semantics; their completed outputs are never
reinterpreted as valid actions.

Authenticated same-origin `POST /api/assistant/design-runs` admits a design job
directly using exactly `{ threadId, content }`. It reuses chat's own thread-read
handler to check session ownership, then resolves the design profile and
permission ceiling on the server. It accepts no identity, engine, profile or
action-key overrides and performs no preliminary model turn.

The server's pass executor uses its existing authenticated assistant route and
engine adapters with job-bound limits. Design passes offer only read/proposal
tools: replay and schema repair cannot repeat mutation effects. The run produces
a concrete proposal (`operations: [{ tool, args }]`) in the original thread.
A ready v3 final proposal is applied by its deterministic check through the
existing core cookbook service. The host supplies an application/run/action
identity; an action's index is stable and core pins its exact arguments. Preview
creates a native durable owner hold in the existing thread approval UI. Its
ordinary decision route executes the held action with current owner permissions
intersected with the original ceiling, then queues the same final check. That
check recovers the exact core result before advancing to `done`; it never makes
another model call. With preview off, additive changes apply directly and still
enter change history. Destructive changes always retain native owner approval.
An unready final v3 proposal terminates as failed with the host's plain note that
no changes were applied and more information is needed. It creates no approval
hold or history entry. Historical v1/v2 review semantics are preserved. The
profile grants no authority. The model
never applies effects as part of a replayable schema pass. Deterministic Fresh,
template application and Start over keep their established policy; only actual
assistant work starts a design job.

Stop also pauses new effects from an existing native hold. The ordinary owner
decision can still record approval while stopped, returning its normal approved
state without consuming or executing it. Explicit Resume applies that same hold
once and completes the run. Denial remains a durable terminal decision. Stop
does not reverse an effect already recorded in change history.

Explicit owner Resume can migrate a completed v2 `app.addField` review proposal
to v3's final check without repeating its model passes. This narrow adapter pins
the core argument schema from committed `d3b879bef0` using core's exported
`stableStringify`; other v2 operations require a fresh v3 run. Migration requires
a ready nonempty proposal valid against the current supported core schemas, its
original permission ceiling, live thread ownership and application revision, and
no job or execution lease. One
transaction compares the exact old payload, revision and scoped identity before
changing the definition; attempts, outputs, usage and run id are preserved. A
proposal/schema fingerprint prevents later drift. New v3 runs persist their own
schema pin, preserve it through every check and validate it before native
continuation effects. V1 and unready v2 outputs are never migrated. HTTP cannot
select a definition, action or profile.

Crash recovery preserves the persisted final-check lease. The old job must first
be terminally recovered by TaskRunner's worker-liveness sweep, with an
authoritative `stale-recovery` outcome for that exact job/attempt. Owner Resume
then atomically admits a new existing job against the unchanged checkpoint. Its
real replacement claim authorizes check replay and core returns the exact
committed action result. Generic failed jobs and a live original worker do not
qualify; no lease is cleared to bypass ownership.

Inference reserves unknown usage conservatively, accumulates time/tokens across
passes and preserves usage on resume. The host's `readResource` callback is
owner-bound and paged; missing resource support fails closed.

## Reuse audit

Before adding the adapter, read `docs/knowledge/intents/index.md`, invoked MCP
`review_smrt_project` for template-sveltekit and `build_context` for durable
cookbook design composition, and searched smrt-ui, smrt-svelte, chat, core, jobs
and inference by name and purpose (`DesignRun`, durable passes, schema validation,
`runAssistantTurn`, engine adapters, job admission). Existing inference
checkpoints/driver and jobs runner own persistence and execution; the host owns
only its cookbook passes and authenticated callback composition. Core already
owns Ajv as a direct dependency; this package declares its own direct dependency
for its host validation rather than reaching through core's dependency tree.

`__tests__/cookbookDesignRuns.test.ts` uses in-process SQLite and the real
TaskRunner. It verifies admission before execution, owner isolation, stopped-run
resume after replacing the host, active Stop with preserved usage and permission
ceiling, immediate resume of a cooperatively settled pass with a 30-minute lease,
uncooperative execution retaining its reservation, late release refused after a
job claim changes, three ordered checked passes, schema repair and
unknown-usage cumulative budget exhaustion/resume, and durable final-check
replay. Its 22 tests include narrow historical schema drift, live
revision/permission rejection and concurrent migration. The real host suite
verifies default native preview and the
existing approval POST, direct preview-off history, destructive approval,
denial, approval deferred by Stop, schema repair without effects and scoped
history projection. Its
file-backed SQLite crash scenario suspends the completion checkpoint after a
real core mutation, simulates worker death with public liveness retirement,
observes TaskRunner's real orphan outcome and recovers the exact result under a
replacement job claim without clearing the persisted lease or calling a model
again. No external engines or containers are involved.
