# AI usage observability (#4751)

`_smrt_ai_usage` answers "how does model X do on prompt Y". Sources:
`src/adapters/ai-usage.ts` (persistence), `src/system/ai-usage-observability.ts`
(outcome labels, report), `src/class.ts` (`listAiUsage` / `summarizeAiUsage`).

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
`substitutions` (JSON array, #4752), `fusionKey` (#4753). Indexes:
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
`tier`, `class`, `tenant`, `fusion`. It reads bounded keyset pages and
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
