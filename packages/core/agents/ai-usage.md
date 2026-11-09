# AI usage observability (#3077, #4751, #4753, #4760, #4780)

`_smrt_ai_usage` answers "how does model X do on prompt Y". Sources:
`src/adapters/ai-usage.ts` (persistence), `src/adapters/ai-usage-recorder.ts`
(the shared pipeline and public recorder, #3077),
`src/system/ai-usage-observability.ts` (outcome labels, report), `src/class.ts`
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
event's `tags`. `AiUsagePersistenceHandler` copies five of them into nullable
indexed TEXT columns (`AI_USAGE_TAG_COLUMNS`); `tags` always keeps the full map.

| Tag | Column | Producer |
|---|---|---|
| `promptKey` | `prompt_key` | `resolvePrompt()` via `promptMessageOptions()` (smrt-prompts) |
| `tierRequested` | `tier_requested` | inference tier path (#4750) |
| `tierResolved` | `tier_resolved` | inference tier path (#4750); fallback (#4752) |
| `runId` | `run_id` | multi-call runs, e.g. fusions (#4753) |
| `callId` | `call_id` | transcript wrapper, while transcripts are enabled (#4780) |

Tag-only keys read by the report: `promptLayer` and `templateHash` (prompts),
`substitutions` (JSON array, #4752), `fusionKey` (#4753), `source` (binding
origin `byo | local | hosted | app`, #4756). `userId` (#4760) and the hosted
gate's audit tags (`reason`, `policy`, `cap`, `spend`, `resetsAt`,
`disabledBy` on `operation: 'blocked'` rows) stay in `tags`; smrt-subscriptions
meters `source`/`userId` with a case-sensitive exact-fragment match on `tags`. Indexes:
`idx_smrt_ai_usage_prompt_key (prompt_key, created_at)`, `idx_smrt_ai_usage_run (run_id)`,
`idx_smrt_ai_usage_call (call_id)`.
The tier filters of `listAiUsage()` have no index on purpose: four-value
columns, always read with a time window that `idx_smrt_ai_usage_created` serves.

Existing databases receive the columns from
`ensureAiUsageSystemTableCompatibility()` inside the bootstrap compatibility
pass (column-existence-guarded ALTER on SQLite, PostgreSQL, DuckDB) before the
1.13.0 DDL replay creates the indexes. No backfill: old rows keep NULL columns
and their `tags`. A writer must not depend on the columns without
`ensureSystemTables()` having run. `pruneAiUsage()` is unchanged.

## Run records (`_smrt_ai_runs`, #4753)

Source: `src/system/ai-runs.ts`. One row per multi-call run (a fusion):
`id` (the `runId` every seat's usage row carries in `run_id`), `fusion_key`,
`mode`, `tenant_id` / `class_name` (the instance's, like a usage row),
`prompt_key` of the entry call, `seats` that ran, `degraded_seats` (died or
answered through a substitution), `status` (`ok | degraded | failed`),
`duration` and `details` (JSON, per seat: `persona` (the seat name), prompt,
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
- Indexes: `created_at`, `(fusion_key, created_at)`, `(tenant_id,
  created_at)`; `status` is always read with one of them. `tenant_id` stays
  TEXT like `_smrt_ai_usage.tenant_id`. `run_id` is not a foreign key.
- Retention: the sweep's `ai-usage` task prunes runs with the AI usage age
  bound (`pruneAiRuns()`); a usage row-count bound does not apply to runs.
- Schema 1.14.0 creates the table through `ensureSystemTables()` (new table,
  no compatibility ALTERs). PostgreSQL lane:
  `issue-4753-ai-runs-postgres.optional.test.ts`.

## Outcome labels

`recordAiUsageOutcome(db, { usageId?, runId?, callId?, label, score?,
evidence?, actor, tenantId?, createdAt? })` writes `_smrt_ai_usage_outcomes`
(`callId`, #4780: every usage row of the call, else its transcript, names
the tenant). A run cannot rate
itself, so labels are recorded when the verdict is known. Rules:

- The target must exist (`AI_USAGE_OUTCOME_UNKNOWN_TARGET`); the label takes the
  target's tenant, and an explicit `tenantId` must match it, as must every row
  of a run (`AI_USAGE_OUTCOME_TENANT_MISMATCH`). Never relax this into a
  cross-tenant write.
- `usage_id` / `run_id` are not foreign keys: retention prunes usage rows and
  must neither be blocked by nor cascade into labels. Labels are low-volume and
  not swept; a pruned target leaves the label with an empty `usage` join.
- `listAiUsageOutcomes(db, filters)` returns labels newest first with the
  judged rows (`usage`), joined only within the label's tenant.

## Report (`smrt ai:usage`)

`reportAiUsage(db, { by, since, until, tenantId })` groups by `prompt`, `model`,
`tier`, `class`, `tenant`, `fusion`, `source`. It reads bounded keyset pages and
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
  change it (owner decision: no tenant override). Invalid values throw
  (`assertInferenceTranscriptsConfig()`, also in `assertInferenceConfig()`).
- **Disabled means untouched.** Clients are not wrapped, no `callId` is
  minted, call options are byte-identical (the #4750 parity contract). So
  `call_id` is set only while transcripts are enabled, on every call then,
  sampled or not.
- **Capture point.** `withAiTranscripts(client, context)` is a `Proxy` that
  intercepts `message`, `chat`, `complete` and `stream` (chunks assembled),
  consumes the per-call `transcript` option, merges `callId` into
  `usageTags` (reusing a caller's), and binds every other member to the
  client. `SmrtClass` wraps what it hands out: `getAiClient()` (hence
  `do()` / `is()` / `describe()` / `evaluate()`'s generative route and
  `prepareAiOperation()`, which takes `transcript` from the options), the
  `ai` getter and `getOptionalAiClient()`; wrappers are cached per raw
  client. Inner executor clients (`clientFor`) are never wrapped, so a chain
  or fusion is one transcript whose seats share its `callId`. The typed
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
  `[REDACTED]` for values under credential-named keys (also inside strings
  that hold JSON, such as serialized tool arguments), smrt-config
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
  allowCrossTenant, callId?, runId?, promptKey?, templateHash?, outcome?,
  labelled?, since?, until?, limit? = 50 (max 500), audit? })`, newest first,
  each with `usage` (rows sharing `call_id`) and `outcomes` (by `call_id`,
  `run_id` or a usage id), joined only within the row's tenant. Without
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
  `_smrt_ai_usage` and `_smrt_ai_usage_outcomes`, added to existing tables by
  `ensureAiUsageSystemTableCompatibility()`. Tests:
  `issue-4780-ai-transcripts.test.ts`, PostgreSQL lane
  `issue-4780-ai-transcripts-postgres.optional.test.ts`.
