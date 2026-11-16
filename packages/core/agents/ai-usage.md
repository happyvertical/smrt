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
- User (#4760): `setAiUsageUserResolver()` is the ambient-user slot. When
  registered (the hosted gate registers the principal's user), every row
  whose event and attribution carry no `userId` tag gets the resolver's
  user as `userId` (`AI_USAGE_USER_TAG`); an explicit tag wins and a
  throwing resolver attributes nothing. Per-user hosted spend caps meter
  that tag.
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
| `runId` | `run_id` | multi-call runs, e.g. fusions (#4753) |
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
`_smrt_ai_evaluations`. No foreign keys between them: retention deletes in
its own order and an evaluation may outlive its target.

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
failed run or its checkpoint is gone).

**Accounting.** Run totals are the budget authority and change only in short
transactions that lock the chain root first (claim fence, then run rows by
depth and id, then event rows) together with the event that justifies the
change; usage rows are the billing ledger and are never read for a budget.
A call is charged once: own totals of its run, inclusive totals of the run
and every ancestor. The reservation state machine is `reserved` → `settled`
| `released` | `abandoned` → `settled_late`, plus `unreserved`; every move is
guarded on the expected state. A refused reservation stops the calling run
with a typed reason and `stop_detail` and throws `AiRunStoppedError`; a
child's stop reaches its parent as a stop (`stopAiRunForChild`). Settlement
never asserts the claim and never looks at status. Status changes
(`transitionAiRun` and everything built on it, `cancelAiRun`,
`stopAiRunForChild`) and `appendAiRunEvent` take the same fence as
`options.fence`: a worker whose claim was taken over gets
`AiRunClaimLostError` before the run is read, and nothing is written.

**Call ids.** Every tracked call gets a call id before it is sent; its usage
row is written with `id = call_id` (`ON CONFLICT (id) DO NOTHING`), so a
retried save never makes a second row. `entry_call_id` is the entry call's id
(the `callId` tag), shared by every call of an alias chain or fusion. A
transcript joins on `_smrt_ai_usage.entry_call_id = _smrt_ai_transcripts.call_id`.

**The tracked client.** `getAiClient(tier, { runTracking: true })` returns a
client whose calls that carry a `runContext` option are calls of that run:
reserved (or, with a held reservation, taking it), sent with the run's usage
tags and the output limit the reservation decided, then settled with their
usage row; the usage handlers run only after the settle commits. The run
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
process) and refuses a run context of another database or tenant.
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
SDK, or call `ai.chat/message/complete/stream` on a client that did not come
from the tracked path, and a tracked call needs a prompt key; the file's short
`ALLOWED` list carries each exception with its reason, and a stale entry
fails.

**Fusions.** The executor opens the fusion run through the context's
`openRun()` (`SmrtClass#openInferenceRun` → `openAiEntryRun`) before the
first seat and closes it at the end; `recordRun()` is no longer passed. A
fusion tier does not run untracked (`AiRunTrackingDisabledError` from
`openRun`). Every seat and the judge reserve together, all or none
(`stop_detail.requested` is the sum over all of them); a seat's first call
takes its share, the judge checks its chain is still `running` first, and
shares never taken are released at the end. Inside a run (the entry call
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
Payloads are redacted (host redactor, then the transcript redactor) and
capped (head and tail kept, `truncated`); `payload_ref` points at content the
host owns, and the framework stores nothing behind it.

**The `ai-runs` task** (retention sweep, `sweepAiRuns`): reconciles `call`
reservations older than the smallest `callTimeoutMs` on their chain plus a
minute (else an hour) by settling from a usage row or abandoning; closes a
run that is not durable after 24 quiet hours as `failed` / `abandoned`;
cancels any run left under a cancelled ancestor and any `waiting-approval` or
durable `stopped` run under a final or missing ancestor; then prunes
trajectories and run rows (below). Worker reconciliation on claim:
`reconcileAiRunOnClaim`.

**Retention** (page section 8). A finished, unprotected run keeps its
trajectory `aiRuns.trajectoryMaxAgeDays` (30) after `finished_at`; with
`trajectorySampleRate` below 1, a run outside the sample (decided from its
id) loses it once finished. Pruning saves the check and approval counts on
the row and sets `trajectory_pruned` in the same transaction as the events
are deleted, and deletes the checkpoint unless the run `failed`. Protected:
`running`, `waiting-approval`, durable `stopped`, `experiment_id` set,
`retain` set, and (through the top-down order) every descendant of a
protected run; a child is never pruned before its parent, and a run with a
call still `reserved` keeps its events. Run rows go with their usage rows at
the `aiUsage.maxAgeDays` limit (90) counted from `finished_at`, never while
the trajectory is kept, top down; the failed run's checkpoint goes with its
row. Usage rows keep their own policy. Evaluations are never swept. Index:
`idx_smrt_ai_runs_finished` (schema 1.19.0).

**Readers.** `listAiRuns(db, { id?, type?, definitionKey?, status?,
parentRunId?, experimentId?, tenantId?, since?, until?, limit? })` returns
every type in the run vocabulary (a legacy `ok` / `degraded` row reads as
`done`, with `degraded`; the `fusionKey` and `ok` / `degraded` filters still
work). `reportAiRuns(db, { type?, since?, until?, tenantId? })` groups by
`(type, definition_key)`: runs per status, degraded, seats, own calls,
tokens and cost, checks and approval decisions with their rates (from the
events, or the saved counts of a pruned trajectory), p50 active time; other
tenants counted in `excluded`. `getRunTrajectory(runId | { callId })` is the
one reader for a call in a run and a call on its own. CLI: `smrt ai:usage
--runs` (every type), `--by fusion` (fusion runs).

**Upgrades.** Schema 1.14.0 created the fusion table; 1.17.0 rebuilt it once
(`ensureAiRunsSystemTableCompatibility()`, only while it still has
`fusion_key`: new shape, rows copied as `type 'fusion'` with `finished_at =
created_at` and `started_at = created_at - duration`), moved stored `ok` /
`degraded` to `done` (with `degraded`) and `failed` to `failed` / `error` in
one guarded UPDATE, and added events, checkpoints and evaluations; later
1.17.0 work added `stop_detail`, `retry_of_run_id` and double-precision cost
columns; 1.19.0 adds `idx_smrt_ai_runs_finished`. On PostgreSQL a table with
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
the same tenant, looked up per page by id; never content, so not audited. It reads bounded keyset pages and
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
- Rows outside `tenantId` and external-agent measurements are counted in
  `excluded`, not dropped silently.
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

Public usage recorder, `withAiUsage()`, ambient-tenant and ambient-user (#4760) slots, gateway cost ids (#3077); usage tags lifted to `prompt_key`/tier/`run_id` columns, evaluations, `ai:usage` report (#4751); AI runs of every type, events, trajectories, budget accounting, the tracked client (`createTrackedAiClient`, one per tenant and database, a prompt key on every call; `scripts/check-tracked-ai-calls.mjs` keeps code on it), fusion runs opened at start, the `ai-runs` sweep and run retention (#4753, #5005; [docs/content/ai-runs.md](../../docs/content/ai-runs.md)); opt-in `_smrt_ai_transcripts` with `call_id`, redaction, audited tenant-scoped reads (#4780); tenant-scoped prompt/model comparison and template history (#4782)

`pnpm lint` also runs `scripts/check-tracked-ai-calls.mjs` (#5005): package code makes no model call outside the tracked client, every tracked call carries a prompt key, and a short `ALLOWED` list holds each exception with its reason.
