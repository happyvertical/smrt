# runOnce: shared idempotency seam (#3080)

`src/run-once.ts`. A DB/transaction-level primitive — it takes a
`DatabaseInterface`, not a `SmrtObject`/`SmrtCollection` — so it works outside
SvelteKit and outside the ORM. Any caller with a database handle and a
JSON-serializable work result can use it.

## Why this exists, and why it is not the token alone

Every consumer with a form, a retried request, or a double-tapped button
needs the same guard, and a first hand-rolled attempt at it (reported against
this issue) keyed the claim on the per-form token alone. That silently
collapsed two genuinely different submissions that happened to reuse one
form's token — the exact bug this primitive exists to prevent everyone from
re-introducing.

## Key derivation

```
contentDigest = sha256(stableStringify(content))
claimKey      = sha256(stableStringify([tenantId, actor, token, contentDigest]))
```

`stableStringify` (`../src/knowledge-graph.ts`) is sorted-key JSON: property
insertion order never changes the digest. Folding in `tenantId` and `actor`
means two tenants or two actors can never collide on the same claim even if a
token were somehow shared between them; folding in `contentDigest` means a
retry of the SAME submission (same token, same content) replays, while a
DIFFERENT submission through the same token (edited content before a
resubmit) runs as its own claim.

Neither the raw token nor the raw content is ever persisted — only their
digests — so `_smrt_run_once_claims` cannot leak submitted business data.

## Placement: `smrt-core`, not `smrt-svelte`

The issue posed this as a judgement call. `runOnce()` lives in `smrt-core`
beside the other write primitives (`object.ts`, `collection.ts`) because:

- It is DB/transaction-level, not SvelteKit-specific — any caller with a
  `DatabaseInterface` can use it, including CLI jobs, MCP tool handlers, and
  non-web callers.
- The claim table must exist for every `smrt-core` consumer, not only ones
  that also depend on `smrt-svelte`.

No SvelteKit form-token helper shipped alongside it. The token contract
(mint a random, unguessable value once per rendered form; carry it as a
hidden field or equivalent; pass it straight through to `runOnce()`) is a few
lines any consumer already owns as part of rendering its own form, and there
was no existing svelte-facing package this fit into without adding one. If a
second consumer needs the exact same minting/reading helper, add it to
`smrt-svelte`'s forms module then — do not add a package for one caller.

## Schema: a hand-DDL system table, not an `@smrt()` model

`_smrt_run_once_claims` is declared in `src/system/schema.ts`
(`CREATE_SMRT_RUN_ONCE_CLAIMS_TABLE`), added to `ALL_SYSTEM_TABLES`, and
created by `ensureSystemTables()` / `bootstrapSystemTables()`
(`src/system/bootstrap.ts`) — the same mechanism that creates
`_smrt_migrations` and `_smrt_contexts`. This is "Mechanism A" in the
`_smrt_` prefix classification ([schema-paths.md](schema-paths.md)), not
"Mechanism B" (an `@smrt()`-decorated model migrated via `db:migrate`, like
`_smrt_jobs`).

This was a deliberate choice, not the default: `runOnce()` must work for any
`smrt-core` consumer without that consumer registering a class and running a
migration for a table they've never heard of. A Mechanism-B table only exists
once an app imports and registers its owning class; a Mechanism-A table
exists for every `smrt-core` database unconditionally, which is what a
framework-wide primitive needs.

Adding the table required:

- A new DDL constant in `ALL_SYSTEM_TABLES`.
- Bumping `SMRT_SCHEMA_VERSION` (1.10.1 → 1.11.0) — `CREATE TABLE IF NOT
  EXISTS` is a no-op on an existing database, so nothing upgrades without the
  bump.
- A new `SMRT_SCHEMA_DDL_CHECKSUMS` entry — `system-schema-evolution.test.ts`
  recomputes the DDL hash and fails the build if it does not match the
  recorded value for the current version.

No new column was added to an existing system table, so no
`addColumnIfMissing()` entry in `system/compatibility.ts` was needed. Live
schema parity (`checkLiveSchemaParity`, `smrt doctor --db` /
`db:status --parity`) picks the table up automatically: system-table shape
parsing (`schema/system-table-shapes.ts`) derives its expectation from the
same DDL rather than a hand-maintained list.

## Table shape

```sql
CREATE TABLE IF NOT EXISTS _smrt_run_once_claims (
  claim_key TEXT PRIMARY KEY,       -- the derived key above
  tenant_id TEXT NOT NULL,          -- redundant with claim_key; kept for admin queries and a defense-in-depth tenant filter on lookup
  actor TEXT NOT NULL,              -- same
  content_digest TEXT NOT NULL,     -- same, plus lets an operator distinguish "same token, different content" incidents
  status TEXT NOT NULL DEFAULT 'in_progress',  -- 'in_progress' | 'completed'
  result TEXT,                      -- JSON-serialized work() return value, set only when status = 'completed'
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
```

`claim_key` is the PRIMARY KEY — the "insert-only against a UNIQUE column"
the issue asked for. A second `INSERT` for the same key never adopts the
existing row.

**Why the claim insert is raw SQL (`INSERT ... ON CONFLICT (claim_key) DO
NOTHING RETURNING claim_key`), not a plain `INSERT` caught for a classified
`unique_violation`:** on PostgreSQL, a statement that raises an error aborts
the WHOLE transaction ("current transaction is aborted, commands ignored
until end of transaction block") — every later statement in that same
transaction fails too, including the `SELECT` `runOnce()` needs to read the
winner's stored result back. A first version of this primitive did exactly
that (plain `INSERT` + catch classified via `isUniqueViolationError`,
`../src/db-errors.ts`) and every replay/double-submit on PostgreSQL broke:
review caught it before merge. `DO NOTHING` never raises — it reports zero
rows via `RETURNING` instead — so the transaction's error state is never
touched. SQLite and DuckDB support the identical `ON CONFLICT ... DO
NOTHING` / `RETURNING` syntax (already used elsewhere in this codebase for
`_smrt_migrations`, `system/bootstrap.ts`), so one query is portable across
every adapter without engine branching.

## Atomicity and rollback

`runOnce()` opens `db.transaction()` (or nests under a caller-supplied
transaction, per `@happyvertical/sql`'s own SAVEPOINT /
`NestedTransactionError` rules) and, inside it: inserts the claim
(`in_progress`), runs `work(tx)` with that SAME transaction-bound handle, then
updates the claim to `completed` with the JSON-serialized result — all one
transaction.

If `work()` throws, the callback throws, and `db.transaction()`'s own
commit-on-success/rollback-on-error contract undoes the claim insert along
with whatever `work()` partially wrote. A claim is never stranded
`in_progress` by a failed attempt; a retry with the same key can always run
again. No compensating delete is needed — this falls out of using one
transaction for the whole claim+work+completion sequence, not a special case
in `runOnce()`'s own code.

## Concurrency

`@happyvertical/sql`'s single-connection adapters (SQLite, DuckDB, JSON)
serialize `transaction()` calls on one connection: a second, concurrent
`runOnce()` call does not begin its own transaction until the first ends.
PostgreSQL pools, but the claim insert's arbiter still has to check the
unique index against another transaction's uncommitted row of the same
PRIMARY KEY, and blocks until that transaction resolves, then either no-ops
(committed — `DO NOTHING` fires, zero rows) or inserts (rolled back). On
every adapter, two concurrent callers with the same key never both run
`work()`, and the loser never sees a PostgreSQL error for it — only zero
rows back, at which point it reads the now-committed, now-`completed` claim
row and replays its stored result.

This is also why the "in flight" and "unknown outcome" branches below are
normally unreachable through `runOnce()`-to-`runOnce()` races alone on a
single connection — the losing transaction can only ever observe a
COMMITTED row, and this module only ever commits a row once it is
`completed`. They are kept as defined answers (not assumptions) for a claim
row that reached that state some other way, and are exercised in
`src/__tests__/issue-3080-run-once.test.ts` by seeding the table directly and
by unit-testing the pure resolver (`resolveExistingRunOnceClaim`).

## Typed answers: refused vs. unknown outcome (mirrors #2990)

A conflict on insert is a *definite* decision — the row exists — but whether
it is safe to hand back a result depends on `status`:

| Row state after conflict | Result |
|---|---|
| `status: 'completed'` | Replay the stored `result`. No error. |
| exists, not completed | `RunOnceClaimError.inFlight()` — `code: 'RUN_ONCE_IN_FLIGHT'`. Some execution holds this key right now; retry later with the SAME token and content. |
| conflict reported, no row readable | `RunOnceClaimError.outcomeUnknown()` — `code: 'RUN_ONCE_OUTCOME_UNKNOWN'`. Genuinely indeterminate; retrying with the SAME token and content is still safe. |

Both error codes live on one `RunOnceClaimError` class (`src/errors.ts`),
following this codebase's existing error-hierarchy convention (one class,
multiple codes via static factories — see `TenantIsolationError`,
`DatabaseError`) rather than a bespoke class hierarchy. Neither is retried
automatically by `runOnce()` itself: only the caller knows whether retrying
inline is appropriate for its own request.

## Tests

`src/__tests__/issue-3080-run-once.test.ts` (real in-memory SQLite via
`getTestDatabase({ classes: [] })` — no `@smrt()` model is needed, only the
system table):

- Runs work once; returns its result.
- Retry after completion replays the stored result without re-running.
- Concurrent double submit (`Promise.all`) produces one claim row and the
  same result for both callers.
- Same token, different content → two separate claims (guards the
  token-alone regression this issue was filed against).
- Same token/content, different actor → separate claim.
- Same token/content, different tenant → separate claim.
- Work throws → claim rolls back; a subsequent retry with the same key runs.
- A claim seeded directly as `in_progress` → `RunOnceClaimError.inFlight()`,
  `work()` never called.
- Content-digest stability (key order) and sensitivity (value change) are
  unit-tested directly.
- `resolveExistingRunOnceClaim` (pure resolver) is unit-tested for all three
  branches, including the otherwise-unreachable `outcomeUnknown` case.

`src/__tests__/issue-3080-run-once-postgres.optional.test.ts` (real
PostgreSQL, `SMRT_TEST_POSTGRES_URL`, `describe.skipIf`, following
`change-feed-concurrency.optional.test.ts`'s established pattern: distinct
`dbid`s for two genuinely concurrent connections, `getTestDatabase({ db,
classes: [] })` to bootstrap system tables): replay after completion, and
concurrent double submit across the two real connections — both would
reject with a PostgreSQL `DatabaseError` ("Failed to retrieve record from
table", the driver's wrapping of 25P02 "current transaction is aborted")
against the pre-fix plain-`INSERT`-and-catch version; verified locally
against a disposable `postgres:18-alpine` container (revert via patch file,
confirmed both tests red, restored, confirmed both green) since the SQLite
suite cannot reach this PostgreSQL-specific failure mode at all.
