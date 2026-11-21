# AI usage observability and AI runs (#3077, #4751, #4753, #4760, #4780, #4782, #5005)

`_smrt_ai_usage` answers "how does model X do on prompt Y". Sources:
`src/adapters/ai-usage.ts` (persistence), `src/adapters/ai-usage-recorder.ts`
(the shared pipeline and public recorder, #3077),
`src/system/ai-usage-observability.ts` (evaluations, report), `src/class.ts`
(`listAiUsage` / `summarizeAiUsage`). AI runs, events, budgets and their
retention (#5005) are under [AI runs](#ai-runs-_smrt_ai_runs-4753-5005).

## Recording from any client (#3077)

One pipeline serves every client: `normalizeAiUsageEvent()` →
`estimateAiUsageCost()` → handlers (`AiUsagePersistenceHandler` when a db is
present and `persist` is on, plus `usage.handlers`; instances also keep an
`AiUsageCollector`). Usage config merges as global `config({ usage })` < local.

- `createAiUsageRecorder({ db?, className?, tenantId?, usage?, tags?, aiConfig? })`
  returns an `onUsage` sink for clients that are not SMRT objects. It never
  rejects; `tags` sit under the event's own tags; `aiConfig` is the
  provider/model fallback.
- `attachAiUsageRecorder(aiConfig, recorder)` returns a copy whose `onUsage`
  runs the caller's callback, then the recorder. Re-attaching replaces the
  previous sink instead of stacking it.
- `SmrtClass#withAiUsage(aiConfig, { tenantId?, tags? })` does the same with the
  instance's pipeline: `getAI(this.withAiUsage(this.options.ai))`.
- Sinks are branded. When `SmrtClass` builds its own client (default or tier)
  from a config that already carries one, it drops the sink and keeps the
  wrapped caller callback, so a call is recorded once; the sink's explicit
  `tenantId`/`tags` (`aiUsageSinkAttribution`) still apply, while class name,
  instance tenant and ambient tenant follow the building instance. Keep that
  unwrap and attribution on every client the class builds (default and tier).
  `withAiUsage()` on a config that already carries a sink inherits its explicit
  attribution unless its own options set one. Instance clients record even when
  the caller's callback throws (the error still propagates).
- User (#4760): a row's `userId` (`AI_USAGE_USER_TAG`) comes only from
  trusted sources: the sink attribution's tag (host code that built the
  sink), else `setAiUsageUserResolver()`'s user (the hosted gate registers
  the principal's). A per-call `usageTags.userId` is dropped, and a throwing
  resolver attributes nothing. Per-user hosted spend caps meter that tag.
- Tenant: explicit `tenantId` (a string; `null` = global, skip ambient) →
  instance `tenantId` (non-empty) → ambient tenant from
  `setAiUsageTenantResolver()` → none. smrt-tenancy registers `getTenantId()`
  there at `enableTenancy()` (a system context yields none). Attribution never
  guesses: with no source the row is global.
- smrt-agents: `resolveAgentAIOptions()` attaches a recorder when given a db,
  and `Agent.initialize()` wires `options.ai` through `withAiUsage()`. Other raw
  `getAI()` sites attach it through `resolveInferenceTarget({ usage })` or
  `withAiUsage()` (#4756; list in [inference.md](inference.md)).
- Cost rates: `aiCostRateKeys()` tries `provider:model`, `model`, then for a
  gateway id (`openai/gpt-4.1-mini`) `openai:gpt-4.1-mini` and `gpt-4.1-mini`,
  one leading segment at a time. Rate lookups use own keys only. The
  missing-rate warning is logged once per `provider:model`.

## Tags and lifted columns

Usage tags arrive through the AI SDK's per-call `usageTags`, merged into the
event's `tags`. `AiUsagePersistenceHandler` copies six of them into nullable
TEXT columns (`AI_USAGE_TAG_COLUMNS`); `tags` always keeps the full map. The
row's own `id` is its call id and is written to `call_id` too (#5005).

| Tag | Column | Producer |
|---|---|---|
| `promptKey` | `prompt_key` | `resolvePrompt()` via `promptMessageOptions()` (smrt-prompts) |
| `tierRequested` | `tier_requested` | inference tier path (#4750) |
| `tierResolved` | `tier_resolved` | inference tier path (#4750); fallback (#4752) |
| `runId` | `run_id` | a tracked call's settlement only (#4753, #5005); on any other event the persistence handler drops it and its step tags |
| `callId` | `entry_call_id` | transcript wrapper, while transcripts are enabled (#4780); the entry call's id, shared by the calls of a chain or fusion. A row without the tag is its own entry call |
| `templateHash` | `template_hash` | prompt version (smrt-prompts, #5005) |

Tag-only keys read by the report: `promptLayer` (prompts),
`substitutions` (JSON array, #4752), `fusionKey` (#4753), `source` (binding
origin `byo | local | hosted | app`, #4756). `userId` (#4760) and the hosted
gate's audit tags (`reason`, `policy`, `cap`, `spend`, `resetsAt`,
`disabledBy` on `operation: 'blocked'` rows) stay in `tags`; smrt-subscriptions
meters `source`/`userId` with a case-sensitive exact-fragment match on `tags`. Indexes:
`idx_smrt_ai_usage_prompt_key (prompt_key, created_at)`, `idx_smrt_ai_usage_run (run_id)`,
`idx_smrt_ai_usage_entry_call (entry_call_id)` (non-unique: it replaced the
`call_id` index, and `call_id` equals the primary key). Schema 1.17.0 (#5005)
also added the nullable `step_index`, `step_name`, `step_instance_id` and
`attempt` columns, written by the run driver (`docs/content/ai-runs.md`).
The tier filters of `listAiUsage()` have no index on purpose: four-value
columns, always read with a time window that `idx_smrt_ai_usage_created` serves.

Existing databases receive the columns from
`ensureAiUsageSystemTableCompatibility()` inside the bootstrap compatibility
pass (column-existence-guarded ALTER on SQLite, PostgreSQL, DuckDB) before the
DDL replay creates the indexes. No backfill, except the call id split: one
guarded UPDATE sets `entry_call_id = COALESCE(call_id, id)`, then `call_id = id`,
and finds nothing to change on a second run. Other old rows keep NULL columns
and their `tags`. A writer must not depend on the columns without
`ensureSystemTables()` having run. `pruneAiUsage()` is unchanged.

## AI runs (`_smrt_ai_runs`, #4753, #5005)

The model, its words and its rules are in
[docs/content/ai-runs.md](../../../docs/content/ai-runs.md); this section maps
them to code. Every model call is recorded once, as its usage row; a run
(a fusion, a chat turn, a workflow, an owner's `@scope/pkg:type`) is laid over
those rows. A call on its own is not a run (`run_id` NULL).

| Source | Holds |
|---|---|
| `src/system/ai-run-model.ts` | `AiRunRow`, statuses and stop reasons, budget keys, the typed errors, `withAiRunTransaction` (5 tries, 10-500 ms jitter, `lock_timeout` on PostgreSQL), chain and subtree readers, `lockAiRunChainFenced` (claim fence first) |
| `src/system/ai-run-lifecycle.ts` | `openAiRun` (tracking check, durable checkpoint, retry, child `handoff`), guarded status changes (`transitionAiRun`, `stopAiRun`, `cancelAiRun`, `finishAiRun`, `waitAiRunApproval`), `startAiRunStep`, checkpoints, `resumeAiRun`, `stopAiRunForChild`, `closeAiRunForJob` |
| `src/system/ai-run-accounting.ts` | Reservation sizing and `reserveAiCall(s)` (all or none), `settleAiCall`, `releaseAiCall`, reconciliation, the pending settlement list, `sweepAiRuns`, `checkAiRunTotals` / `repairAiRunTotals` |
| `src/system/ai-run-events.ts` | `appendAiRunEvent` (seq in the insert's transaction, redact then cap), `closeAiRunHandoff`, `countAiRunEvents` / `aiRunApprovalRate`, `getRunTrajectory` |
| `src/system/ai-run-calls.ts`, `src/ai-run-client.ts` | The explicit `AiRunContext` (and its job-payload form), held reservations, `beginAiRunCall` / `runAiRunCall`, the tracked client proxy |
| `src/system/ai-run-entry.ts` | `openAiEntryRun`: the run of a multi-call entry call (a fusion), opened at its start |
| `src/system/ai-run-retention.ts` | `pruneAiRunTrajectories`, `pruneAiRuns`, `isAiRunTrajectorySampled` |
| `src/system/ai-runs.ts` | Readers `listAiRuns` / `reportAiRuns`; deprecated `recordAiRun` |
| `src/system/ai-run-policy.ts` | The six decided product rules as constants (`AI_RUN_POLICY`) |

**Run context on operations.** `AiOperationOptions.runContext` (an
`AiRunContext`) is how `is()` / `do()` / `describe()` join a run: explicit,
never ambient. `prepareAiOperation` keeps it in the call options, the tracked
client reserves and settles under it, and it never reaches the provider.

**Tables.** `_smrt_ai_runs` (one row per run: type, definition, status,
stop fields, budget, own, inclusive and reserved totals, saved check and
approval counts, `retain`, `trajectory_pruned`), `_smrt_ai_run_events`
(`(run_id, seq)` unique inline; `call` events carry the reservation state and
amounts as typed columns), `_smrt_ai_run_checkpoints` (durable runs only: a
checkpoint row is what makes a run durable; `revision` is compare-and-swap),
`_smrt_ai_evaluations`, `_smrt_ai_run_ids` (1.20.0: the hex SHA-256 of every
run id ever opened, no tenant column, never deleted). No foreign keys
between them: retention deletes in its own order and an evaluation may
outlive its target.

**Run identity** (`ai-run-model.ts` `insertAiRunRowTx`, `ai-run-ids.ts`). A
run id names at most one run for the lifetime of the database. Every run
row is written through `insertAiRunRowTx` (`openAiRun`, the deprecated
`recordAiRun`; `ai-run-insert-sites.test.ts` fails on any other `INSERT INTO
_smrt_ai_runs`), which in the caller's transaction refuses an id whose
digest is reserved or whose run row still exists, then reserves the digest
before the row; a unique violation from a concurrent opener that committed
first is the same final `AiRunIdUsedError` (`AI_RUN_ID_USED`), never
retried. A caller-chosen id must be a non-empty, well-formed string without
NUL (`TypeError`, before any read). Without the registry table an open fails
with a `TypeError` before any write and creates nothing. `pruneAiRuns`
reserves the id before it locks and deletes the row (the open's lock order:
registry key, then run row). The 1.20.0 bootstrap backfills the digest of
every id still present or referenced (runs, events, checkpoints, usage,
evaluations, transcripts) after its compatibility step and DDL replay and
before its stamp, in keyset pages (SQL `sha256` on PostgreSQL and DuckDB,
TypeScript on SQLite). The guarantee holds from cutover: reuse before the
upgrade is not repaired; `checkAiRunIdRegistry(db)` (`smrt doctor --db`)
counts referenced ids with neither row and children created before their
parent. Deploy: drain older-core openers and sweepers first, never run an
older core against a 1.20.0 database, keep the registry through restores. A
refusal discloses that an id was used, even after expiry; callers choose
unguessable ids.

**Opening needs tracking.** `openAiRun(store, input)` throws
`AiRunTrackingDisabledError` while `store.usageTracking` is off
(`SmrtClass#aiRunStore()` says on only while usage is enabled and persisted
and the instance has a database), before anything is written or sent. The
check is made only at open: settlements of an open run always write their
usage row inside the settle transaction, whatever the setting says later.

**Statuses** move only by a guarded update from the expected status
(`AI_RUN_TRANSITIONS`; `waiting-approval` and leaving `stopped` are durable
only). A stop of a run that is not durable is final. `cancelAiRun` is the one
subtree write: in one transaction it cancels the run and every descendant
that is not final (`running`, `waiting-approval`, durable `stopped`), locking
the run, then descendants by depth and id; each gets `stopped_by_run_id` the
cancelled run, `stop_detail` NULL, `finished_at` set. Every other stop reaches
descendants lazily, at their next reservation or step start. `resumeAiRun`
reads the whole chain and refuses with `AiRunResumeRefusedError`:
`not_resumable`, `ancestor_missing`, `ancestor_final`, `budget_unchanged`,
`budget_lowered`, `above_ceiling`, `definition_changed`; a retry (`openAiRun`
with `retryOfRunId`) adds `not_retryable` and `retry_source_pruned` (the
failed run or its checkpoint is gone); a retry for another owner than the
failed run's (`ownerId ?? null` compared under the source lock, before the
checkpoint is read or `carry` runs) is `not_retryable`. `openAiRun` compares the locked
parent's and retry source's `tenant_id` (null-safe) with `store.tenantId`
before reading anything else: another tenant's run is treated as absent
(`AiRunNotFoundError` for a parent, `retry_source_pruned` for a retry), and
refusal messages never name the other run's definition. Each referenced
run is first looked up by id and the store's tenant (a SQL predicate)
before anything of it is locked or read, its depth is walked in that tenant,
and the row returned is the one inserted, read inside the open's
transaction. `openAiRun` reads each public property of `store` and `input`
exactly once (own fields and getters alike; `satisfies` keeps the copy
exhaustive) and serializes tags, budget and the first checkpoint before its
first write, so a caller-owned transaction never commits half an open.
Every chain walk (`readAiRunChainIds`,
hence `lockAiRunChain`, fences and charges) and every descendant walk
(`readAiRunDescendantIds`, cancel; the sweep's non-durable subtree) stops at
a tenant boundary, with the tenant as a predicate of each lookup (another
tenant's run is never read), and the sweep's orphan repair and both
retention passes join a parent only within the child's tenant (null-safe),
so a parent of another tenant reads as a missing one. A link written before
this check never carries a charge, stop, cancel or retention decision
across tenants.

**Accounting.** Run totals are the budget authority and change only in short
transactions that lock the chain root first (claim fence, then run rows by
depth and id, then event rows) together with the event that justifies the
change; usage rows are the billing ledger and are never read for a budget.
A call is charged once: own totals of its run, inclusive totals of the run
and every ancestor, and only against its own usage row (the row under its
id, of its run, in its run's tenant): when another run's or tenant's row
holds the id, settlement returns the reservation and charges nothing, and
the stale-reservation reconciler never settles from such a row. The reservation state machine is `reserved` → `settled`
| `released` | `abandoned` → `settled_late`, plus `unreserved`; every move is
guarded on the expected state. A refused reservation stops the calling run
with a typed reason and `stop_detail` and throws `AiRunStoppedError`; a
child's stop reaches its parent as a stop (`stopAiRunForChild`). Settlement
never asserts the claim and never looks at status. Status changes
(`transitionAiRun` and everything built on it, `cancelAiRun`,
`stopAiRunForChild`) and `appendAiRunEvent` take the same fence as
`options.fence`: a worker whose claim was taken over gets
`AiRunClaimLostError` before the run is read, and nothing is written. Only a
fence that returns `false` or throws `JobClaimLostError` (matched by name) or
`AiRunClaimLostError` means the claim is gone; any other error it throws (a
lock timeout, a write conflict on the job row) is rethrown as is, so
`withAiRunTransaction` retries it.

**Call ids.** Every tracked call gets a call id before it is sent; its usage
row is written with `id = call_id` (`ON CONFLICT (id) DO NOTHING`), so a
retried save never makes a second row. The `aiCallId` tag is core's: in
`AiUsagePersistenceHandler` it stays the row id only for the settled event
and for an event naming a call id this process minted (a host recorder on
its own client converges on the same row); any other event carrying it is
written under its own id without the tag (warned once), and the same event
object saved twice still writes one row. Such an event's `runId` and step
tags are dropped too, so a caller's tags never place a row in a run. `entry_call_id` is the entry call's id
(the `callId` tag), shared by every call of an alias chain or fusion. A
transcript joins on `_smrt_ai_usage.entry_call_id = _smrt_ai_transcripts.call_id`.

**The tracked client.** `getAiClient(tier, { runTracking: true })` returns a
client whose calls that carry a `runContext` option are calls of that run:
reserved (or, with a held reservation, taking it), sent with the run's usage
tags and the output limit the reservation decided, then settled with their
usage row; the usage handlers run only after the settle commits. A call's
usage still reaches it after it ended, because the SDK does not await
`onUsage` and an app's own callback runs first. Its capture stays registered
for 60 s (`ai-run-client.ts`), and `beginAiRunCall` opens a route for the
call id it minted (`src/system/ai-run-late-usage.ts`, not exported; bounded
to 10 000 calls and one hour per process) holding the call's database, run
and tenant; the route, not the caller, holds the once-only state.
`dispatchAiUsageEvent` hands an event carrying `aiCallId` and `runId` to the
route only when the pipeline's persistence database, the `runId` tag and
the event's tenant all match, so a caller's `aiCallId` tag alone (another
database, tenant or run) is never applied to the call. The route takes an
event only when it has something to apply, once: a call released without
usage settles late (`settled_late`); a call settled from its response or
fallback row (a decision that recorded no usage included) gets its usage
row and its tenant-bounded chain's totals corrected to the provider's
measured counts, after its settlement has committed (a queued settlement
included), retried on failure (a redelivery retries too), never touching a
row of another run or tenant under the id and never taking a total below
zero. An event without token counts never replaces counts. Every event the
route does not take reaches the handlers as it would without it; the
settled event itself is marked (`markAiRunSettledUsageEvent`) and never
routed back. **Known limit:** the route is process-local. A late event
delivered on another worker, after an hour or after 10 000 newer calls
leaves a call settled from its response or fallback with those counts (a
detectable estimate, never another call's usage) and reaches the handlers
again; a released call is still settled from its persisted reservation by
the persistence handler (`reconcileLateAiRunUsage`), so its row and its
run's totals agree. The run
context is always passed explicitly, never read from a process-wide variable;
`serializeAiRunContext` / `restoreAiRunContext` carry it through a job payload
(tenant-checked). Without `runTracking` a client is exactly as before.
`do()`, `is()` and `describe()` take `runContext` in their options and hand it
to the executor's client, so an alias chain's answering call is a settled call
of the run. A client that sends no usage event (a host's own client) settles
from the response's own `usage` and `model`; a zero-token row is the last
resort.

`createTrackedAiClient({ db, tenantId, ai?, inference?, usage?, className?,
transcript?, label? })` (`src/tracked-ai-client.ts`) is the entry point for code that
is not a `SmrtObject` (chat, the app shell, background workers). It is built
for ONE tenant and database (an internal `SmrtClass` host: nothing is kept per
process) and refuses a run context of another database or tenant: bound at
`client()` or passed on a single call (`message(x, { runContext })`, streams
too), the context's database, its declared tenant and its run row's tenant
must all be the client's, checked before anything is reserved or sent;
the context is copied before the check and only the copy is used, so
changing the caller's object afterwards cannot move a call to another run;
the accepted copy carries the client's validated tenant (an explicit `null`
included), so accounting never looks a context's tenant up again; the
database is likewise captured at construction, never re-read from the
caller's options. A context's tenant reaches every lookup of its call: the
reservation, the claim fence (the chain is read in that tenant before the
fence is called), a held reservation's admission, settlement, release and a
child's stop. A held reservation (a fusion seat's share) is admitted just
before it is sent in both modes: a context's claim fence is asserted first,
in the same transaction (`AiRunClaimLostError` for a worker whose claim was
taken over); with `checkRunning` the chain is locked and
must be `running`; either way the held call's own event must still be
`reserved` in that run, else the call is refused (`AiRunNotFoundError` for a
run that is gone, `AiRunTransitionError` for a reservation released or
abandoned meanwhile) and nothing is sent. A
call of a run is billed to the run row's tenant (the settlement writes the
usage row with it and the handlers see it), never the ambient tenant.
`openRun(input)` opens a run there (`AiRunTrackingDisabledError` while usage
persistence is off); `client(prompt, { runContext? })` returns a client made
for one prompt: every call on it is tagged with the prompt's `promptKey` and
`templateHash`, belongs to `runContext` when one is given, and a prompt
without a key is refused (`AiPromptKeyRequiredError`). Core never imports
`smrt-prompts`: the caller resolves the prompt (`resolvePrompt`) and
`trackedPromptCall(resolved)` of smrt-prompts turns the resolution into the
`prompt` argument. `transcript: false` is for a host that stores the
conversation itself. `label: { provider, model? }` names what a client the
host built itself is recorded as (an engine such as `chatgpt`); a model the
response reports wins. An engine that runs its own loop (a Claude Code or
Codex CLI) makes no call through a client: its turn is one
`beginAiRunCall` of the run, ended `succeed()` (answered) or `fail()`; a
`fail()` after a captured usage event settles it with `cancelled`,
`timed_out` or `failed`. `pnpm lint` runs `scripts/check-tracked-ai-calls.mjs`:
package code may not build a provider client (`getAI`), import a provider
SDK, or call `chat/message/complete/stream` on a client that did not come
from the tracked path (each receiver judged by its own origin in the file),
and a tracked call or `.client()` needs a prompt key; the file's short
`ALLOWED` list carries each exception with its reason, and a stale entry
fails. It is a text scan with known limits (listed in its header): origins
match by name across the whole file, not by scope, so a tracked `ai` in one
function covers a provider `ai` in another; `.client(` on a receiver whose
origin the file does not show counts as tracked; a quote inside a regular
expression literal blanks the rest of its line.

**Fusions.** The executor opens the fusion run through the context's
`openRun()` (`SmrtClass#openInferenceRun` → `openAiEntryRun`) before the
first seat and closes it at the end; `recordRun()` is no longer passed. A
fusion tier does not run untracked (`AiRunTrackingDisabledError` from
`openRun`). Every seat and the judge reserve together, all or none
(`stop_detail.requested` is the sum over all of them); a seat's first call
takes its share, the judge checks its chain is still `running` first, and
shares never taken are released at the end. The parent's claim fence is
read once and asserted by the reservation, every seat's admission and the
run's close and stop (each release and the finish in their own
transactions): a worker whose claim was taken over releases, finishes and
stops nothing (`AiRunClaimLostError`). Inside a run (the entry call
carries a `runContext`), the fusion is a child run and the parent gets a
`handoff` event (`child_run_id`, `call_id` = the entry call, no reservation),
written with the child's row and ended `done`, `stopped`, `cancelled` or
`failed` with it. Seat usage rows carry `run_id` = the fusion run, `fusionKey`
and `seat` tags. A gate is a seat too: its `gate` share (`later`, so checked
`running` first, with a short verdict back) is reserved with the others, and
the decision call (`decide(request, { runContext })`) takes it and settles with
a usage row tagged `runId` and `seat: gate`. A seat's share is priced from the
rate card at its first concrete target (an alias's or inline chain's first
candidate, through nested aliases) and counts its prompt's instructions as
input; a judge adds 240 characters of framing and the panel's output
allowances. A chain that never answered writes its zero-token row as an
unreserved call of the run (its own call id, nothing reserved or released).
`details` hold identities and totals only
(seat persona, prompt key, target and model labels, usage, substitutions,
failure class; gate verdict): never prompts, inputs, outputs or keys.

**Events.** `call` (a pointer to its usage row), `action`, `observation`,
`check` (`passed | failed`), `approval` (`requested`, then a decision
`approved | refused` whose `parent_event_id` is the request, possibly in an
earlier run, possibly pruned) and `handoff` (`running` until its child ends).
A `check` or `approval` request points at the judged `call` or `handoff`
event. A decision counts once, in the run that recorded it; a request counts
only as requested; approval rate = approved / (approved + refused).
Payloads are redacted through the transcripts' one path
(`redactAiTranscriptPart`: an event-specific `options.redact`, then the host
redactor with the run row's tenant, read behind the claim fence, then the
built-in redactor) and
capped (head and tail kept, `truncated`); `payload_ref` points at content the
host owns, and the framework stores nothing behind it. Read-time rule:
`getRunTrajectory` runs only the built-in redactor again on stored payloads
(credential-named fields, token shapes; the host redactor runs on the write
path only and is never called by a read), so a payload stored by an earlier
version is masked by today's built-in rules; a truncated payload's `head` and
`tail` (JSON text fragments) are masked at string level
(`maskSecretFieldsInJsonText`: credential-named field values, then token
shapes), never returned as stored. A host's field-based policy installed
after a payload was written does not apply to it.

**The `ai-runs` task** (retention sweep, `sweepAiRuns`): reconciles `call`
reservations older than the smallest `callTimeoutMs` on their chain plus a
minute (else an hour) by settling from a usage row or abandoning; closes a
run that is not durable after 24 quiet hours as `failed` / `abandoned`;
cancels any run left under a cancelled ancestor and any `waiting-approval` or
durable `stopped` run under a final or missing ancestor; then prunes
trajectories and run rows (below). Worker reconciliation on claim:
`reconcileAiRunOnClaim`, which establishes the claimed run's tenant once and
carries it into every descendant lookup, reservation read, reconciliation
and status lock, so a row that left the tenant after discovery is neither
reconciled nor failed. `checkAiRunTotals` reads the run's stored totals and
its charged calls with their own usage rows in one statement anchored on the
run: a settle or prune committing meanwhile is seen whole or not at all, and
a run that is gone is `AiRunNotFoundError`.

**Retention** (page section 8). A finished, unprotected run keeps its
trajectory `aiRuns.trajectoryMaxAgeDays` (30) after `finished_at`; with
`trajectorySampleRate` below 1, a run outside the sample (decided from its
id) loses it once finished. The destructive recheck under the run lock uses
the bound that selected the run: the cutoff for a run in the sample, `now`
for one outside it. Pruning saves the check and approval counts on
the row and sets `trajectory_pruned` in the same transaction as the events
are deleted, and deletes the checkpoint unless the run `failed`. Protected:
`running`, `waiting-approval`, durable `stopped`, `experiment_id` set,
`retain` set, and (through the top-down order) every descendant of a
protected run; a child is never pruned before its parent, and a run with a
call still `reserved` keeps its events. Run rows go with their usage rows (only
those of the run's own tenant: `run_id` is not a foreign key) at
the `aiUsage.maxAgeDays` limit (90) counted from `finished_at`, never while
the trajectory is kept, top down; the failed run's checkpoint goes with its
row. Usage rows keep their own policy. Evaluations are never swept. Index:
`idx_smrt_ai_runs_finished` (schema 1.19.0).

**Scoped reads.** `getAiRun(db, id, scope?)` and `readAiRunCheckpoint(db, id,
scope?)` take an `AiRunReadScope` (`{ tenantId, ownerId?, type? }`): every
field given is a predicate of the one statement (the checkpoint is read
joined to its run), so a run outside the scope is never read, only not
found. Callers that authorize by tenant and owner (the workflow checkpoint
store, its retry pre-check) read through it.

**Readers.** `listAiRuns(db, { id?, type?, definitionKey?, status?,
parentRunId?, experimentId?, tenantId?, since?, until?, limit? })` returns
every type in the run vocabulary (a legacy `ok` / `degraded` row reads as
`done`, with `degraded`; the `fusionKey` and `ok` / `degraded` filters still
work). `reportAiRuns(db, { type?, since?, until?, tenantId? })` groups by
`(type, definition_key)`: runs per status, degraded, seats, own calls,
tokens and cost, checks and approval decisions with their rates (from the
events, or the saved counts of a pruned trajectory), p50 active time; other
tenants are neither read nor counted (`tenantId` is a predicate of the page
query; `excluded.otherTenants` is always 0, deprecated). `getRunTrajectory(runId | { callId })` is the
one reader for a call in a run and a call on its own; a usage row leads it
only to a run of the row's tenant (the run is read by id and tenant in one
statement, and every event page is scoped to the run's tenant, so a pruned
and reused id never yields another tenant's run), a call on its own carries only its tenant's evaluations, and a
run's usage rows and evaluations are joined within the run's tenant. CLI: `smrt ai:usage
--runs` (every type), `--by fusion` (fusion runs).

**Upgrades.** Schema 1.14.0 created the fusion table; 1.17.0 rebuilt it once
(`ensureAiRunsSystemTableCompatibility()`, only while it still has
`fusion_key`: new shape, rows copied as `type 'fusion'` with `finished_at =
created_at` and `started_at = created_at - duration`), moved stored `ok` /
`degraded` to `done` (with `degraded`) and `failed` to `failed` / `error` in
one guarded UPDATE, and added events, checkpoints and evaluations; later
1.17.0 work added `stop_detail`, `retry_of_run_id` and double-precision cost
columns; 1.19.0 adds `idx_smrt_ai_runs_finished`; 1.20.0 adds
`_smrt_ai_run_ids` and its backfill (`backfillAiRunIdRegistry`, from
`bootstrapSystemTables`, not from a compatibility pass, so it sees the
replayed DDL). On PostgreSQL a table with
legacy timezone-naive timestamps is left alone and the bootstrap fails closed
until the audited timestamp migration has run.

Tests: `issue-5005-ai-run-lifecycle.test.ts`, `-accounting`, `-cancel-resume`,
`-entry`, `-retention`, `-readers`, `-tracked-client`, `-schema`,
`issue-4753-ai-runs.test.ts`; PostgreSQL lanes `*-postgres.optional.test.ts`;
fusion runs end to end in smrt-inference `issue-5005-fusion-runs.test.ts`.

## Evaluations

`recordAiEvaluation(db, { callId | runId, metric?, value?, valueType?, scale?,
label?, evidence?, evaluator, tenantId?, createdAt? })` writes
`_smrt_ai_evaluations` (#5005; it replaced `_smrt_ai_usage_outcomes` and
`recordAiUsageOutcome`). An evaluation attaches to exactly one call (`callId`,
the usage row's id) or exactly one run (`runId`); a fusion is judged through
its run. `metric` defaults to `outcome`; `value` is stored as text and read
back through `valueType` (`number | boolean | text`, inferred from the value);
`evaluator` is `human`, `app` or `grader:<name>@<version>`, so the evaluator's
version is part of the string. A run cannot rate itself, so evaluations are
recorded when the verdict is known. Rules:

- The target must exist (`AI_EVALUATION_UNKNOWN_TARGET`); the evaluation takes
  the target's tenant, and an explicit `tenantId` must match it, as must every
  row of a run (`AI_EVALUATION_TENANT_MISMATCH`). Never relax this into a
  cross-tenant write.
- A run is judged by its run row's tenant (its usage rows only when the row
  is gone), so a run with no call, or whose usage was pruned, can be judged.
- `call_id` / `run_id` are not foreign keys: retention prunes usage rows and
  run rows and must neither be blocked by nor cascade into evaluations.
  Evaluations are never swept; a pruned target leaves the evaluation with an
  empty `usage` join and `target: null`, never an error.
- `listAiEvaluations(db, filters)` returns evaluations newest first with the
  judged rows (`usage`) and `target` (`{ kind: 'call', usage }` or `{ kind:
  'run', id, type, definitionKey, status, promptKey, templateHash }`, NULL
  once pruned), joined only within the evaluation's tenant. Per-prompt
  measures reach a prompt through the target, so they leave such an
  evaluation out.
- The 1.17.0 upgrade copies old labels across
  (`ensureAiEvaluationsSystemTableCompatibility()`): a `usage_id` becomes the
  `call_id`; a label with only an entry `call_id` goes to the call whose
  `entry_call_id` matches, else the run those calls share, else the latest of
  them, else (usage pruned) keeps the id; a `run_id` stays; `score` becomes
  `value` (`number`), `actor` becomes `evaluator`, `metric` is `outcome`.

## Report (`smrt ai:usage`)

`reportAiUsage(db, { by, since, until, tenantId, transcripts? })` groups by
`prompt`, `model`, `tier`, `class`, `tenant`, `fusion`, `source`, `template`
(the `templateHash` tag, #4781). `transcripts: true` adds `transcripts` to each
bucket and the totals: calls (distinct `entry_call_id`) with a transcript row of
the same tenant, looked up per page by id; never content, so not audited.
`since` defaults to 30 days before `until` (or now) and the report's `since`
is the start it used, so no caller reads the whole history by accident (the
inference settings page passes none). `tenantId` is a SQL predicate of the usage pages
(`idx_smrt_ai_usage_tenant_created`), the evaluation lookups and the
transcript lookups, so other tenants' rows are neither read nor counted:
`excluded.otherTenants` is always 0 (deprecated) and `excluded.externalAgent`
counts the filtered tenant's measurements. Evaluation labels are looked up per page for
that page's call and run ids (`IN` lists of at most 500). It reads bounded
keyset pages and
aggregates in memory so the median and tag dimensions stay portable. Pages
are keyed on `id` within the `created_at` window: correct, but on very large
windows each page rescans the window; keyset on `(created_at, id)` is a
follow-up that needs per-engine timestamp round-tripping. A filter
selects what is totalled, never what is accounted for:

- Hosted-gate blocks (`operation: 'blocked'`, #4760) count in `blocked`,
  beside `calls` and never in it: no tokens, cost, duration or
  unattributed count.
- NULL dimension values are their own bucket (`(unattributed)` in the CLI);
  `unattributedCalls` counts calls without a prompt key.
- `estimatedCost` sums recorded costs only; rows without a rate are
  `uncostedCalls`, never priced as zero. `costBasis` states the rate card.
- External-agent measurements are counted in `excluded.externalAgent`, not
  dropped silently. Rows of other tenants are not read at all.
- A run-level or call-level label counts once per bucket containing the
  run or call and once in the totals; a label naming a usage row counts on
  that row. A label naming several targets judges the narrowest (usage row,
  then run, then call).

## Transcripts (`_smrt_ai_transcripts`, #4780)

Sources: `src/ai-transcripts.ts` (capture, browser-safe),
`src/system/ai-transcripts.ts` (write and read), `class.ts`
(`transcriptClient()`, `aiTranscriptContext()`). Opt-in readable content of
a call for prompt tuning; usage rows stay metadata-only.

- **Config, app level only.** `config({ inference: { transcripts: { enabled,
  sample = 0.1, maxBytes = 65536, prompts: { '<key>': { sample } } } } })`
  (smrt.config < `config()` < env `SMRT_INFERENCE_TRANSCRIPTS=1|0`). Read
  from the process config only (`resolveAiTranscriptConfig()`): instance
  `inference` options, resolvers and tenant settings cannot turn it on or
  change it (owner decision: no tenant override). One app-level layer
  sits under the env (#4781): `setAiTranscriptAppSettings({ enabled?,
  sample?, maxBytes? } | null)` (globalThis, no `prompts`), fed by
  smrt-inference's stored app row; `getInferenceTranscriptsConfig(app)`
  computes the merge. Invalid values throw
  (`assertInferenceTranscriptsConfig()`, also in `assertInferenceConfig()`).
- **Disabled means untouched.** Clients are not wrapped, no `callId` is
  minted, call options are byte-identical (the #4750 parity contract). So
  a usage row's `entry_call_id` is its own id unless transcripts are enabled,
  when it is the minted `callId` on every call, sampled or not.
- **Capture point.** `withAiTranscripts(client, context)` is a `Proxy` that
  intercepts `message`, `chat`, `complete` and `stream` (chunks assembled),
  consumes the per-call `transcript` option, merges `callId` into
  `usageTags` (reusing a caller's), and binds every other member to the
  client. `SmrtClass` wraps what it hands out: `getAiClient()` (hence
  `do()` / `is()` / `describe()` / `evaluate()`'s generative route and
  `prepareAiOperation()`, which takes `transcript` from the options), the
  `ai` getter and `getOptionalAiClient()`; wrappers are cached per raw
  client. Inner executor clients (`clientFor`) are never wrapped, so a chain
  or fusion is one transcript whose seats share its `callId` (their usage rows'
  `entry_call_id`). The typed
  decision route captures through `captureAiTranscriptCall()` with the
  request and its answers. Raw `getAI()` sites: subclasses pass their client
  to `this.transcriptClient(client, undefined, { tenantId, secrets })`
  (languages, projects; `secrets` returns the site client's key); other sites use `resolveInferenceTarget({ transcript, usage })`
  and its result's `instrument(client)` (stores into `usage.db`). Chat passes
  `transcript: false` and never instruments: smrt-chat stores conversations
  itself.
- **Capture decision** (`aiTranscriptCaptureReason()`): `transcript: false`
  never; `transcript: true`, a thrown call, a call whose usage events carry
  non-empty `substitutions`, or a call whose fusion run is `degraded` /
  `failed` always; otherwise one draw against the prompt's sample rate.
  Usage pipelines feed raw events to `observeAiTranscriptUsage()` before any
  enabled/persist check (`handleAiUsageCallback()`, the #3077 recorder), and
  `recordInferenceRun()` calls `noteAiTranscriptRun()`. Metrics and labels
  are never sampled.
- **Redaction.** The host redactor (`setTranscriptRedactor((messages,
  context) => messages)`, on `globalThis`) runs per part (`request`,
  `response`, `tools`), then the built-in `redactAiTranscriptMessages()`
  always runs: exact masks for the client's `apiKey` (instance, options,
  decision config, every tier-target key the instance bound, and a raw
  site's own key passed as `transcriptClient(..., { secrets })`, which adds
  to the instance's) and the calling object's `sensitive` field values
  (`[REDACTED:<field>]`; values under 4 characters only as whole tokens),
  `[REDACTED]` for values under credential-named keys; strings that hold
  JSON (tool arguments, JSON-mode answers) are parsed so field masks, exact
  numbers (a long all-digit value also by its parsed double, so a 19-digit
  number `JSON.parse` rounds still matches), keys and whole serialized
  values (matched before their members) apply inside them; Date fields are
  masked as their ISO string; smrt-config
  `redactSecretValues()` token shapes, binary as `[binary]`. Errors are stored by message after the same
  redaction.
- **Row.** `request` `{ messages, options }` (model, temperature, tool
  names, ...), `response` `{ messages, finishReason?, capture }` (`capture`
  is the reason), `tool_events` (assistant tool calls, tool results, response
  tool calls) or NULL; `fitAiTranscript()` keeps parts within their fair
  share of `maxBytes` and turns larger ones into `{ truncated, originalBytes,
  head, tail }` JSON envelopes; `truncated` is INTEGER 0/1 (system-table
  flag convention), `bytes` the stored size. `tenant_id` follows the usage
  row's attribution; `run_id` the call's fusion run. A write failure is
  logged once, never thrown; without a database nothing is stored.
- **Reads.** `listAiTranscripts(db, { actor, reason?, tenantId |
  allowCrossTenant, callId?, runId?, promptKey?, templateHash?, label?,
  labelled?, since?, until?, limit? = 50 (max 500), audit? })`, newest first,
  each with `usage` (rows sharing `entry_call_id`) and `evaluations` (by a
  usage row's id or `run_id`), joined only within the row's tenant. Without
  `tenantId` (`null` = global rows) it throws `AiTranscriptScopeError` unless
  `allowCrossTenant: true`. Every read audits: one `AuditEntry` per returned
  row (`action: 'read'`, `resourceType: '_smrt_ai_transcripts'`) through
  `options.audit` or the active `withAuditContext()` writer, and a failing
  writer fails the read; with neither, a structured `info` log line (ids,
  never content). CLI: `smrt ai:transcript <callId> --tenant <id> |
  --all-tenants [--actor]`, `smrt ai:usage --with-transcripts [--prompt]`.
- **Retention.** `DEFAULT_RETENTION_POLICY.aiTranscripts = { maxAgeDays: 30
  }`, task `ai-transcripts` (`pruneAiTranscripts()`), independent of
  `aiUsage` so labels and metrics outlive content.
- **Schema 1.15.0**: the table (indexes `call_id`, `run_id`, `created_at`,
  `(tenant_id, created_at)`, `(prompt_key, created_at)`) and `call_id` on
  `_smrt_ai_usage` and `_smrt_ai_usage_outcomes` (since replaced, see
  Evaluations), added to existing tables by
  `ensureAiUsageSystemTableCompatibility()`. Tests:
  `issue-4780-ai-transcripts.test.ts`, PostgreSQL lane
  `issue-4780-ai-transcripts-postgres.optional.test.ts`.

## Comparing prompt versions and models (#4782)

Source: `src/system/ai-prompt-compare.ts`. Read-only helpers over the usage
rows of one prompt key; no model judges anything (labels come from
`recordAiEvaluation()`).

- **Scope.** Both take `tenantId` (`null` = global rows) or
  `allowCrossTenant: true`, else throw `AiUsageScopeError`
  (`AI_USAGE_TENANT_REQUIRED`) before any query. The tenant is a predicate
  on every query (usage, labels, runs, transcripts), so other tenants' rows
  are neither read nor counted; cross-tenant joins key on `(tenant, id)`
  because run and call ids are free text another tenant can reuse.
- `compareAiPromptRuns(db, { promptKey, a, b, since?, until?, tenantId |
  allowCrossTenant, transcriptLimit? = 50 (max 500) })`. A side is exactly
  one of `{ templateHash }` (the tag), `{ model }` (`provider:model` or the
  bare model id) or `{ tier }` (`tier_resolved`, else `tier_requested`).
  Per side: `calls`, `blocked` (beside calls), tokens, `estimatedCost` /
  `costedCalls` / `uncostedCalls` / `meanCost`, `latencyMs` p50/p90/p95/p99
  (nearest rank), `fallbackCalls`/`fallbackRate` (non-empty `substitutions`),
  `degradedCalls`/`degradedRate` (the row's `_smrt_ai_runs` run is
  `degraded | failed`), `evaluations`, `labels`, `scoredLabels`, `meanScore`,
  `callIds` (distinct entry calls), `transcriptCount` and `transcripts` (ids, call ids, labels,
  worst score; worst-labelled first, unlabelled last). Rates are per usage
  row, the unit `ai:usage` counts. Label counting follows `reportAiUsage()`:
  a call's label on its row, a run label once per side. #5005 adds
  `steps` / `repairedSteps` / `repairRate` (distinct `run_id:step_instance_id`
  among the side's rows, repaired when one has `attempt > 1`),
  `checksPassed` / `checksFailed` / `checkPassRate` and `approvalsGiven` /
  `approvalsRefused` / `approvalRate`: a check (or an approval decision,
  through its request, even from another run) counts against the side whose
  call it judged, or, for a `templateHash` side, whose fusion run (same
  prompt key and template hash) a judged `handoff` names. A decision whose
  request is gone is left out; the counts saved on a pruned run are per run,
  not per prompt, and are not counted here. `templateHash` matches the
  `template_hash` column, else the tag.
- Accounting: `rows` (every row of the prompt in scope), `unmatched`
  (neither side), `inBoth` (totalled on both), `excluded.externalAgent`.
  `costBasis` is the report's.
- Transcript content is never read here, so no audit event; `smrt
  ai:compare --transcripts N` reads the N worst-labelled per side through
  `listAiTranscripts()` (audited, in each row's own tenant).
- `listAiPromptTemplateHistory(db, { promptKey, since?, until?, tenantId |
  allowCrossTenant })`: per `templateHash` tag (`null` = recorded without
  one), `firstSeen`, `lastSeen`, `calls`, `blocked`, `layers`, `models`,
  newest `lastSeen` first.
- Queries: `idx_smrt_ai_usage_prompt_key (prompt_key, created_at)` selects
  the prompt's rows; pages are keyed on `id` like the report's, so on a very
  large prompt each page re-sorts the prompt's rows in the window (correct,
  not cheap; the report's `(created_at, id)` keyset follow-up applies here
  too). Label, run and transcript joins are `IN` lists of at most 500 ids on
  their indexed columns. No new table or index. Tests:
  `issue-4782-ai-prompt-compare.test.ts`, PostgreSQL lane
  `issue-4782-ai-prompt-compare-postgres.optional.test.ts`.


## Scope of the usage and run row (moved from AGENTS.md)

Public usage recorder, `withAiUsage()`, ambient-tenant and ambient-user (#4760) slots, gateway cost ids (#3077); usage tags lifted to `prompt_key`/tier/`run_id` columns, evaluations, `ai:usage` report (#4751); AI runs of every type, events, trajectories, budget accounting, the tracked client (`createTrackedAiClient`, one per tenant and database, a prompt key on every call; `scripts/check-tracked-ai-calls.mjs` keeps code on it), fusion runs opened at start, the `ai-runs` sweep and run retention (#4753, #5005; [docs/content/ai-runs.md](../../../docs/content/ai-runs.md)); opt-in `_smrt_ai_transcripts` with `call_id`, redaction, audited tenant-scoped reads (#4780); tenant-scoped prompt/model comparison and template history (#4782)

`pnpm lint` also runs `scripts/check-tracked-ai-calls.mjs` (#5005): package code makes no model call outside the tracked client, every tracked call carries a prompt key, and a short `ALLOWED` list holds each exception with its reason.
