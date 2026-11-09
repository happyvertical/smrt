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

Hosted-gate blocks (`operation: 'blocked'`, #4760) print in a `blocked`
column beside `calls`.

`ai:compare` and `prompts:history` (#4782, `src/commands/ai-compare.ts`)
wrap core's `compareAiPromptRuns()` / `listAiPromptTemplateHistory()` the
same way, but always need `--tenant` (`global`) or `--all-tenants`.
`--transcripts N` reads each side's N worst-labelled transcripts through the
audited `listAiTranscripts()` and prints them side by side.
