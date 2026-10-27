# Durable deployment data steps

`DeploymentPhaseTracker`, exported from `@happyvertical/smrt-core/migrations`,
is a PostgreSQL-only deployment data-step API. SQL schema steps continue to use
`MigrationTracker`, including its checksums and concurrent-index recovery.

A permanent `_smrt_deployment_steps` ledger keys each step by `application`,
`environment`, and stable `stepId`. Reusing an ID with a different checksum or
execution mode fails before its work or inspection executes. A release identifier
alone is not a stable step ID: otherwise later releases replay old data changes.
There is no retention. Preserve this table when restoring data; deleting markers
permits replay. Checkpoints must never contain secrets. `MAX_DEPLOYMENT_CHECKPOINT_BYTES` limits
serialized checkpoint JSON to 16 KiB measured in UTF-8 bytes, including quotes
and JSON syntax. Oversized or unserializable values fail with
`INVALID_CHECKPOINT` before their ledger query; the prior durable checkpoint is
preserved. Values follow `JSON.stringify` conventions: undefined/null checkpoints
normalize to null, nonfinite numbers become null, object properties containing
undefined/functions/symbols are omitted, and those array elements become null.
Circular references, BigInt, and top-level functions/symbols are rejected.
A checkpoint rejection does not undo prior external effects: reconciliation
still determines whether they completed or may safely resume.

Every execution requires `checkSafety(connection)`: a read-only callback that
throws unless runtime/static schema agreement and writer quiescence have been
proved. It runs after acquiring the scope lock and before any ledger DDL or data
write, including a replay. The caller owns platform fencing and complete writer
inventory; an advisory lock excludes cooperating deployment runners, not runtime
writers. Guards must not open transactions or change session/lock state.

The adapter must expose public `acquireSession()`. A session advisory lock
serializes every step in the same application/environment; the same pinned
session executes data writes and markers. Lock acquisition times out after
`lockTimeoutMs` (default 30 seconds). Other adapters fail closed. DDL provision
runs outside the data transaction under a separate initialization lock. The
migration role needs schema CREATE and ledger read/write permissions.

`runTransactionalStep(options, async tx => { ... })` exposes a query-only handle
on that pinned session. Use **only that handle** for all transactional mutations.
Data and the completed marker commit together. A thrown callback rolls both back;
a lost COMMIT response is never retried internally. On retry, the committed marker
skips work, or the absent marker permits a fresh transaction. Do not issue
transaction control, DDL requiring autocommit, session configuration or advisory
lock changes inside callbacks. Work outside this handle is not made atomic.

`runReconciledStep({ ...options, inspect, apply })` commits a running marker before
calling either callback. `inspect(context)` must independently classify actual
effects as `complete`, `safe-to-resume`, or `needs-repair`. It runs on fresh and
interrupted attempts. Only `safe-to-resume` permits `apply(context)`, and another
inspection must prove complete afterward. `saveCheckpoint(json)` persists a
running checkpoint before external effects; `context.checkpoint` exposes the
latest value. Each effect must tolerate the interval between performing it and
saving its checkpoint. No blind shell-command replay is provided.

A failure records needs-repair if the session survives; process/connection death
can leave running. Both are unresolved and require inspection on the next attempt.
`getStepStatus(key)` is read-only and reports the durable status without guessing
whether a running owner is alive. A reconciler may prove a needs-repair attempt
safe to resume after an operator repairs the underlying problem. A callback that
cannot determine safety must return needs-repair and refuse further mutation.

External effects cannot be atomically fenced by a PostgreSQL connection:
`assertActive()` checks the pinned session, but it cannot stop an already-running
shell command or fence an external service after connection loss. Applications
must supply service-specific fencing/idempotency and truthful inspection, or
require manual repair. This API makes no exactly-once claim for external effects.

Focused validation: `pnpm --filter @happyvertical/smrt-core exec vitest run
src/migrations/__tests__/deployment-phase-tracker-postgres.optional.test.ts` with
`SMRT_TEST_POSTGRES_URL` pointing to an isolated PostgreSQL database. Tests use
separate pools to exercise serialization, atomic marker/data rollback and commit,
checksum refusal, and ambiguous nontransactional recovery.
