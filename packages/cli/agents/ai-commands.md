# AI usage commands (`ai:usage`, `ai:transcript`, `ai:compare`, `prompts:history`)

Read-only CLI wrappers over core's AI usage readers; the contracts live in
[core ai-usage.md](../../core/agents/ai-usage.md).

## `ai:usage` reports, it never filters accounting away (#4751)

A thin wrapper over core `reportAiUsage()`; read-only, it never bootstraps
system tables (a pre-1.13.0 database fails with a hint to start the app or run
`db:migrate`). Calls without a prompt key print as `(unattributed)`, uncosted
calls are counted beside the cost total with the cost basis printed, and rows
outside `--tenant` or from external agents are listed as excluded. `--by fusion`
also totals `_smrt_ai_runs` per fusion via `reportAiRuns()` (#4753).

`ai:usage --runs` (#5005, `reportAiRuns()`) totals runs of every type
(`fusion`, `turn`, `workflow`, an app's own) per definition by status (done,
degraded, open, stopped, cancelled, failed), with fusion seats, own tokens,
check pass and approval rates and p50 active time; JSON adds a `runs` member.
Each `--by` bucket also prints the evaluation labels recorded on its calls
(`recordAiEvaluation`, which replaced the usage outcome). The concepts are in
[AI runs](../../../docs/content/ai-runs.md).

The old `_smrt_ai_usage_outcomes` table is copied into `_smrt_ai_evaluations`
and dropped by core's compatibility pass, not by `db:migrate
--confirm-retire-table` (that flag is for declared retirements; see
[db-migrate-all-or-nothing.md](db-migrate-all-or-nothing.md)).

Hosted-gate blocks (`operation: 'blocked'`, #4760) print in a `blocked`
column beside `calls`.

`ai:compare` and `prompts:history` (#4782, `src/commands/ai-compare.ts`)
wrap core's `compareAiPromptRuns()` / `listAiPromptTemplateHistory()` the
same way, but always need `--tenant` (`global`) or `--all-tenants`.
`--transcripts N` reads each side's N worst-labelled transcripts through the
audited `listAiTranscripts()` and prints them side by side.
