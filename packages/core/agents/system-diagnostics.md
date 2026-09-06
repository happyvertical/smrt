<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# System diagnostics (#1824)

`src/system/diagnostics.ts` is the typed, SELECT-only reader over the
framework-owned `_smrt_*` tables for development tooling (smrt-dev-mcp runtime
diagnostics). It takes a `DatabaseInterface` and never resolves connections,
never writes, and never boots the app — connection resolution, redaction, and
provenance labeling belong to the caller (`packages/smrt-dev-mcp`
`tools/runtime/`).

Categories degrade individually: a missing table or failed read returns a
`CategoryUnavailable` result (`available: false` with `reason`
`table-missing`/`retired`/`read-error`) instead of throwing, an empty-but-
healthy category, or fabricated data. Callers must surface the reason, never
paper over it. `_smrt_registry` is a retired system table and is reported as
retired rather than read — only its existence is probed, never its rows.

Every read is a bounded `SELECT` with an explicit safe-column projection.
Sensitive columns are never selected, not selected-then-stripped: job
`args`/`result_pointer`/task payloads, schedule `agentConfig`/`methodArgs`, and
dispatch `payload`/`metadata` stay in the database; short error texts
(`last_error`, `error_message`) and statuses are surfaced for diagnosis, and
smrt-dev-mcp runs every string in a live result through
`redactConnectionString` before it reaches a client. Migration
counts use `MigrationTracker`'s real vocabulary (`completed`, `running`,
`failed`, `rolled_back`), never an invented `applied`/`pending`. A `running`
job is stuck only when its `worker_heartbeat` is stale or NULL **and** its
worker holds no fresh `_smrt_workers.lease_expires_at` — the same rule the
runner's recovery uses (#1474), so a handler blocking its event loop under a
live off-loop lease is not reported stuck; without the workers table the
heartbeat is the only signal. Row lists honor `DIAGNOSTICS_DEFAULT_LIMIT` (50)
capped at 500; `readRecentChanges()` pages `getChangesSince()` with
`drain: false` (default 200, same cap) so the PostgreSQL staged-entry drain —
a write — never runs from a diagnostic.

Engine compatibility lives in one place: `placeholders(db)` resolves `$n`
numbering (PostgreSQL) versus `?` (SQLite/DuckDB) via the shared
`getDatabaseEngine` convention — explicit `type`/config hint first, then the
connection URL's scheme — and identifiers are never interpolated from caller
input, only from the constant `SYSTEM_DIAGNOSTICS_TABLES` map.
`readSystemDiagnostics()` composes every
category for one-shot snapshots; per-category readers compose it.
