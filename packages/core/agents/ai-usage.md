# AI usage observability (#4751)

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
event's `tags`. `AiUsagePersistenceHandler` copies four of them into nullable
indexed TEXT columns (`AI_USAGE_TAG_COLUMNS`); `tags` always keeps the full map.

| Tag | Column | Producer |
|---|---|---|
| `promptKey` | `prompt_key` | `resolvePrompt()` via `promptMessageOptions()` (smrt-prompts) |
| `tierRequested` | `tier_requested` | inference tier path (#4750) |
| `tierResolved` | `tier_resolved` | inference tier path (#4750); fallback (#4752) |
| `runId` | `run_id` | multi-call runs, e.g. fusions (#4753) |

Tag-only keys read by the report: `promptLayer` and `templateHash` (prompts),
`substitutions` (JSON array, #4752), `fusionKey` (#4753), `source` (binding
origin `byo | local | hosted | app`, #4756). Indexes:
`idx_smrt_ai_usage_prompt_key (prompt_key, created_at)`, `idx_smrt_ai_usage_run (run_id)`.
The tier filters of `listAiUsage()` have no index on purpose: four-value
columns, always read with a time window that `idx_smrt_ai_usage_created` serves.

Existing databases receive the columns from
`ensureAiUsageSystemTableCompatibility()` inside the bootstrap compatibility
pass (column-existence-guarded ALTER on SQLite, PostgreSQL, DuckDB) before the
1.13.0 DDL replay creates the indexes. No backfill: old rows keep NULL columns
and their `tags`. A writer must not depend on the columns without
`ensureSystemTables()` having run. `pruneAiUsage()` is unchanged.

## Outcome labels

`recordAiUsageOutcome(db, { usageId?, runId?, label, score?, evidence?, actor,
tenantId?, createdAt? })` writes `_smrt_ai_usage_outcomes`. A run cannot rate
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
aggregates in memory so the median and tag dimensions stay portable. A filter
selects what is totalled, never what is accounted for:

- NULL dimension values are their own bucket (`(unattributed)` in the CLI);
  `unattributedCalls` counts calls without a prompt key.
- `estimatedCost` sums recorded costs only; rows without a rate are
  `uncostedCalls`, never priced as zero. `costBasis` states the rate card.
- Rows outside `tenantId` and external-agent measurements are counted in
  `excluded`, not dropped silently.
- A run-level label counts once per bucket containing the run and once in the
  totals; a label naming a usage row counts on that row.
