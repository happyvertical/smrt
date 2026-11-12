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

New runs pin `cookbook-design/v2/<passes>`. Their operation schema is a `oneOf`
of the current core cookbook structural tool names and input schemas, resolved
under the live owner. Approval ids are excluded from proposal arguments. The
model sees those exact schemas as proposal data while its callable tools remain
read-only; unknown tool names, MCP wire names and extra arguments enter the same
bounded schema repair path without effects. Persisted v1 runs retain their
original schema and review-pending semantics; their completed outputs are never
reinterpreted as valid v2 actions.

Authenticated same-origin `POST /api/assistant/design-runs` admits a design job
directly using exactly `{ threadId, content }`. It reuses chat's own thread-read
handler to check session ownership, then resolves the design profile and
permission ceiling on the server. It accepts no identity, engine, profile or
action-key overrides and performs no preliminary model turn.

The server's pass executor uses its existing authenticated assistant route and
engine adapters with job-bound limits. Design passes offer only read/proposal
tools: replay and schema repair cannot repeat mutation effects. The run produces
a concrete proposal (`operations: [{ tool, args }]`) in the original thread.
A nonempty final proposal remains `waiting-approval`, with a note that the person
must review and apply it using the app controls. This is review-pending state,
not a claim that a native owner-approval hold has already been created. Resume
cannot mark that proposal applied. Preview-off explicitly reports automatic
application as blocked: owning cookbook tools do not yet accept a trusted stable
run/action replay key at their mutation boundary. The model never applies effects
as part of a replayable schema pass. Applying the proposal continues through
existing preview/approval routes. The profile grants no authority. Deterministic Fresh,
template application and Start over keep their established policy; only actual
assistant work starts a design job.

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
unknown-usage cumulative budget exhaustion/resume, and the explicit preview-off
automatic-apply blocker without effects. No external engines or
containers are involved.
