# AI usage observability (#3077, #4751, #4753, #4760, #4780, #4782)

`_smrt_ai_usage` answers "how does model X do on prompt Y". Sources:
`src/adapters/ai-usage.ts` (persistence), `src/adapters/ai-usage-recorder.ts`
(the shared pipeline and public recorder, #3077),
`src/system/ai-usage-observability.ts` (evaluations, report), `src/class.ts`
(`listAiUsage` / `summarizeAiUsage`).

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

## Run records (`_smrt_ai_runs`, #4753)

Source: `src/system/ai-runs.ts`. The table holds one row for
every kind of run since schema 1.17.0 (#5005: `type`, `definition_key`,
status `running | waiting-approval | stopped | failed | done`, budget, own,
inclusive and reserved totals, retention flags; column list in
`CREATE_SMRT_AI_RUNS_TABLE`, rules in `docs/content/ai-runs.md`). This module
reads and writes the `fusion` rows in the fusion vocabulary: `ok` is `done`,
`degraded` is `done` with `degraded` set, `failed` is `failed` with stop reason
`error`. A fusion row has `id` (the `runId` every seat's usage row carries in
`run_id`), `definition_key` (the fusion key), `mode`, `tenant_id` /
`class_name` (the instance's, like a usage row), `prompt_key` of the entry
call, `seats` that ran, `degraded_seats` (died or answered through a
substitution), `status`, `duration` and `details` (JSON, per seat: `persona` (the seat name), prompt,
status, target and model labels, token usage, substitutions, failure class; gate verdict). Never
prompts, inputs, outputs or keys. Seat usage rows also carry the `fusionKey`
and `seat` tags (`seat: 'gate'` for the gate's decision row).

- Writer: the executor context's `recordRun()` (`class.ts`), only when usage
  is enabled and persisted and the instance has a database; a write failure is
  logged, never thrown. Direct API: `recordAiRun(db, input)`.
- Readers: `listAiRuns(db, { id?, fusionKey?, status?, tenantId?, since?,
  until?, limit? })` (newest first) and `reportAiRuns(db, { since, until,
  tenantId })` (per fusion: runs, ok/degraded/failed, seats, degraded seats,
  p50 duration; other tenants counted in `excluded`). `smrt ai:usage --by
  fusion` prints it beside the usage report.
- Indexes: `created_at`, `(definition_key, created_at)`, `(tenant_id,
  created_at)`, `parent_run_id`; `status` is always read with one of them. `tenant_id` stays
  TEXT like `_smrt_ai_usage.tenant_id`. `run_id` is not a foreign key.
- Retention: the sweep's `ai-usage` task prunes runs with the AI usage age
  bound (`pruneAiRuns()`); a usage row-count bound does not apply to runs.
- Schema 1.14.0 created the table. Schema 1.17.0 rebuilds it once
  (`ensureAiRunsSystemTableCompatibility()`, only while it still has
  `fusion_key`: create the new shape, copy the rows as `type 'fusion'` with
  `finished_at = created_at` and `started_at = created_at - duration`, drop,
  rename) because `fusion_key` became `definition_key` and `mode`, `seats` and
  `degraded_seats` stopped being NOT NULL; then one guarded UPDATE moves the
  stored statuses. On PostgreSQL a table with legacy timezone-naive
  timestamps is left alone and the bootstrap fails closed until the audited
  timestamp migration has run. PostgreSQL lane:
  `issue-4753-ai-runs-postgres.optional.test.ts`.

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
- `call_id` / `run_id` are not foreign keys: retention prunes usage rows and
  must neither be blocked by nor cascade into evaluations. Evaluations are
  low-volume and not swept; a pruned target leaves the evaluation with an
  empty `usage` join.
- `listAiEvaluations(db, filters)` returns evaluations newest first with the
  judged rows (`usage`), joined only within the evaluation's tenant.
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
  a call's label on its row, a run label once per side.
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
