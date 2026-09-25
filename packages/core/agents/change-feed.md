# smrt-core/change feed

Module semantics for `src/change-feed.ts`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Change Feed (#1758)

Adapter-agnostic change-observation spine (`src/change-feed.ts`) — the server half of the client/mobile sync contract (PRD #1755):

- `_smrt_changes` system table: one append per framework save/delete via a GlobalInterceptors writer registered at framework init. Deletes are tombstones (`operation: 'delete'`). `_smrt_*` tables are skipped. Feed-append failures log and never fail the user's write. On PostgreSQL, `_smrt_append_change` catches the INSERT in an exception subtransaction and returns SQLSTATE as data, so swallowing/retrying a best-effort failure cannot leave a caller-managed transaction aborted with `25P02` (#2026); the feed row still commits or rolls back with the caller transaction. Raw-handle/read initialization checks for both the table and helper before issuing any DDL; a cold schema/helper install acquires the same transaction-scoped `('smrt', 'system-tables')` advisory lock as bootstrap before its first DDL and rechecks inside one server-side statement, while schema migration/bootstrap remains the authoritative replace path. No dirty-check: a field-unchanged `.save()` appends a spurious `update` entry (diff-aware paths like `getOrUpsert`/sync-apply short-circuit before `save()` and append nothing); subscribers must tolerate spurious entries — they are convergent.
- Sequences: allocated as `MAX(seq)+1` inside the INSERT with conflict retry (a jittered pause of at most 40 ms between attempts, so two tight-loop writers cannot starve one another — #3062) — committed rows stay contiguous, so commit order == seq order on SQLite/Postgres/DuckDB (deliberately NOT identity/serial: those allocate before commit and break the cursor guarantee under concurrent writers).
- Staged appends (PostgreSQL, #2649): `MAX+1` costs a *wait* — the loser of a primary-key race waits for the winner's whole transaction — so an append inside a caller transaction that already wrote rows would let a long write transaction and an ordinary concurrent request form a real lock cycle (`40P01`, found downstream in willgriffin/willgriffin.dev#457). `_smrt_append_change` therefore checks `pg_current_xact_id_if_assigned()` (PostgreSQL 13+): when the caller already has a transaction id it stages the entry in `_smrt_changes_pending` (identity key, conflicts with nothing, never waits, still rolled back with the caller) and `appendChange()` returns **`null`** instead of a sequence. `_smrt_drain_changes()` moves *committed* staged rows into `_smrt_changes` with contiguous `MAX(seq)+row_number()` sequences under a **try-only** advisory lock, so the drain never waits either. Draining is driven from JavaScript, never inside the append helper: an entry sequenced invisibly server-side would get no live `_events` signal while the append's own signal carried a higher sequence, and a subscriber resuming from that `Last-Event-ID` would skip it permanently. `drainChangeFeed(db)` is called best-effort by `getChangesSince()`, by `pruneChangeFeed()`, and by the append path itself (throttled to one drain per 250 ms per database, bypassed immediately after this process staged an append). The append path issues ONE drain statement (a single bounded pass) and nothing else — the caller may own the surrounding transaction, and a second statement there could fail and abort it behind the feed's own error-swallowing (#2026); the helper's whole body, preflight included, sits inside its exception boundary for the same reason. It still settles that drain's signals in order without spending a statement: a drain that allocated anything assigns a transaction id, so an append that then takes the DIRECT path proves the drain committed, and its signals publish ahead of the append's own; a deferred append proves nothing and queues them. Signals for drained entries publish only after a follow-up probe proves the drain committed, so an uncommitted drain can never advertise a sequence a rollback releases for reuse. `getChangesSince()` additionally holds back everything the handle's own drains allocated while a transaction id is still assigned at read time (a per-handle watermark, so later reads in the same transaction keep holding back), and `bootstrapSystemTables()` refreshes the helpers before its schema-version fast return so an already-stamped database does not keep the deadlocking function. Consequences: the cursor guarantee is unchanged (one `MAX+1` writer at a time, only over committed work), but a staged entry becomes visible one drain after its transaction commits, its log position is drain order rather than statement order, and it publishes its live `_events` signal at drain time (post-commit — the old pre-commit signal could describe a rolled-back write). SQLite/DuckDB keep the direct insert unchanged. Residual: an append issued as a transaction's *first* statement still allocates inline — it holds no row locks then, so it cannot close a cycle, but it can make other direct appenders wait for that commit; issue explicit `bumpChangeFeed()` calls after the write or outside the transaction. A deployment that writes only through transactions and reads the feed from a connection that cannot write must schedule `drainChangeFeed()` on a writable one.
- `getChangesSince(db, { since, tables?, tenantId?, limit? }) → { changes, cursor, resyncRequired?, resyncCursor? }`: strictly monotonic cursor; polling with returned cursors misses no committed change and never repeats one. A cursor that cannot be served incrementally — pruned below the retained `[floor..horizon]` run, or foreign/ahead of the horizon — gets `resyncRequired: true` with empty `changes`, an unadvanced `cursor`, and `resyncCursor` set to the current horizon so clients can full-refetch then resume incrementally; detection runs on the UNFILTERED log so `tables`/`tenantId` filters never trigger or mask it. `getTenantScopedChangesSince()` resolves tenant via the DispatchBus resolver hook (fail-closed: tenancy on + no context → global rows only; tenant `T` sees `T` + global rows, never another tenant).
- `getTableVersion(db, table) → number`: the per-table change version (`MAX(seq)` for the table **plus that table's staged-but-undrained count**, so a staged write still moves the ETag and cannot false-304 a client; the sum is monotonic because draining `n` staged rows raises the table's `MAX(seq)` by at least `n`, and both terms are read in ONE statement — separate reads let a drain be counted twice, minting a version a later write re-mints; replica-stable, with no per-process divergence), the ETag source for zero-query conditional GETs (#1765). Advances on any framework write to the table (CRUD and sync-apply, which all `save()`/`delete()`). A table with no retained entry of its own falls back to the global horizon (never a resettable low value) so an all-pruned table cannot false-304 a stale client; only 0 when the feed is empty.
- Generated `_changes` routes: REST (`GET {basePath}/_changes`, requires `authMiddleware`, otherwise 401 — per-model `api.public` does NOT apply) and SvelteKit (`{routesDir}/_changes/+server.ts`, requires an authenticated principal on `locals`; opt out via `sveltekit.changesRoute.enabled: false`). Query params: `since`, `tables` (comma-separated), `limit`. Responses stay HTTP 200 in the resync state — `resyncRequired` is protocol state, not an error, and `resyncCursor` is the resume cursor after the client completes a full refetch.
- Retention: `pruneChangeFeed(db, { maxAgeMs?, maxRows?, dryRun? })` — scheduled since #2375 by `runRetentionSweep()` (30-day default), so nothing needs to call it directly; `dryRun` counts the same predicate instead of deleting. Pruning deletes oldest-first and always retains the newest entry (a non-empty feed is never emptied), which is what makes pruned-cursor detection provable. The age bound is a **prefix** bound — everything below the oldest entry still inside the window — because `created_at` and `seq` are not co-monotonic (writer clocks skew, and a staged entry carries its stage-time stamp into a later-assigned sequence); deleting by timestamp alone could punch a hole in the middle of the retained run, where `since < floor - 1` cannot see it and keeps caught-up consumers polling normally. Raw-SQL writes are invisible to the feed (same documented gap as the #1499 cache); `bumpChangeFeed(db, { table, rowId? })` is the manual escape hatch.


## Credential-bearing tables are never disclosed (#2937)

`src/change-feed-sensitivity.ts` is a leaf module (it imports nothing, so
`change-feed.ts`, `change-signals.ts` and the registry can all consult it
without a cycle) holding the tables whose **row id or payload is a secret**. A
table joins it two ways: by name, via the baseline
`CHANGE_FEED_CREDENTIAL_TABLES` (`sessions`, `users_cli_auth_requests`,
`users_magic_link_tokens`, `magic_link_tokens`, `api_keys`,
`nostr_identities`), or because a class declared `@smrt({ sensitive: true })`
and registration pushed its resolved table name across
(`declareChangeFeedSensitiveTable`, called from both the decorator and the
manifest-stub registration paths). Both are needed: the declaration is the
package's own contract but only binds in a process where that package
registered, while the name baseline is all the read path has when serving a
database another process writes. The set is **monotonic** — `sensitive: false`
is not an opt-out and nothing removes a name — so a consumer whose domain
table is named `sessions` loses feed coverage for it and must rename it via
`@smrt({ tableName })`.

`isChangeFeedObservableTable()` ANDs the sensitivity check with
`CHANGE_FEED_EXCLUDED_TABLES`, and the refusal is enforced at four points, not
one: the interceptor write path; `appendChange`/`appendChanges`, the lowest
write API, so `bumpChangeFeed()` and any other escape hatch are covered (a
refused append returns `null`, indistinguishable from a staged one);
`deliverLocally` in `change-signals.ts`, which also catches a signal broadcast
by a peer replica running an older build; and **`getChangesSince()`**. The
read-side refusal is what makes upgrading sufficient — rows an earlier version
already wrote stay in the log but are never served. A caller-named sensitive
table is dropped from the `tables` filter rather than erroring, so nothing
confirms the table exists, and a request naming *only* sensitive tables gets
an empty page rather than an unfiltered one. Filtered rows never hold the
cursor back: an exhaustive page still advances to the served horizon.

`pruneChangeFeed()` additionally deletes sensitive rows below the horizon on
every sweep, ahead of either retention bound, so credentials do not sit at rest
for the retention window. That deletes from the middle of the retained run,
which the age bound goes to lengths to avoid — permissible only because these
rows are unservable on every read path, so no page ever contained them and no
cursor can fall into the gap. It **does** move `floor`, and usually will: a
session is created before the first domain write and re-saved on every request,
so the lowest retained sequences are typically credential rows. `floor` is read
live (`MIN(seq)`) on every `getChangesSince` and never cached, so the only
consequence is that a cursor below the new floor is answered `resyncRequired`
and refetches — including a `since=0` client on a never-pruned feed. Extra
resyncs, never a missed change. The horizon does not move, because the newest
entry is retained even when it is sensitive; that preserves "a non-empty feed
is never emptied" and means one credential row can linger until the next write
moves the horizon past it.

Because a non-observable table appends nothing, it also has no ETag source:
`getTableVersion()` would pin at whatever an older build last wrote and then
fall back to the global horizon, which moves only on unrelated traffic — so a
conditional GET could answer `304` for a revoked API key or a rotated session.
`getTableVersion()` therefore returns a deliberately **unrepeatable** value for
such a table — 48 bits of `crypto` randomness per call, not a per-process
counter, because two replicas' clock-seeded counters drift through each other
and the ETag carries no per-process entropy — so no *concrete* `If-None-Match`
can match and every such read is a full 200. It is the single point every ETag
path goes through (the runtime `APIGenerator`, the generated
`conditionalVersionedRead`, and route files an older generator already
emitted), so no call site needs a special case. A wildcard `If-None-Match: *`
still 304s; the read paths evaluate it only after the payload is built, so it
distinguishes nothing an unconditional request would not.

Registration derives the declared name from config and manifest; the writer uses
`instance.tableName`, which resolves through the STI base's schema and then the
class's own. Where those two derivations disagree the declaration lands on a
name nothing writes under, and the real table keeps appending. STI is *not* such
a case today — `@smrt()` already resolves an STI child to its base's table, so a
child declaring `sensitive` declares `<base>` (verified) — but the manifest-stub
and manifest-merge paths derive the name differently again, so registration
declares every candidate name. The authoritative check is at the write path:
`isChangeFeedSensitiveWrite()` asks the registry about the instance's own class
through a resolver hook on the leaf module (so `change-feed.ts` never imports
the registry), sees the exact name being recorded with no derivation to keep in
sync, and declares it — closing the read path and signal bus for that table.

Scope note: the generated `_changes`/`_events` routes authorize on an
authenticated principal plus tenant scoping (`getTenantScopedChangesSince`,
fail-closed) by default. A consumer-supplied table/row authorization seam
beyond that — `change-feed-authz.ts` (#3020, below) — is optional and off
until registered.

## Consumer table/row authorization seam (#3020)

Tenant scoping keeps one tenant from seeing another's rows, but it cannot
express "table X is readable by some principals of the tenant but not others"
or "principal P only sees their own rows of table X" (e.g. a bay-tablet
station versus the back office). `?tables=` on `_changes` was always a
client-chosen filter, never enforcement — a table the client did not ask for
was withheld only because it did not ask, not because it could not have.

`src/change-feed-authz.ts` closes that gap with two independent, optional
hooks, dependency-inverted onto `globalThis` exactly like
`resolveDispatchTenantScope` (`dispatch/tenant-resolver.ts`), so a consumer
registers them once with no change to the generated "DO NOT EDIT" route files:

- `setChangeFeedAuthorizer(authorizeChangeFeed)` — table-level.
  `authorizeChangeFeed({ locals, tables }) => allowedTables` returns the
  tables `locals` may read from the feed at all; the result is INTERSECTED
  with the client's `?tables=` filter (never unioned), so a table the hook
  does not name is never queried, let alone returned.
- `setChangeFeedEntryVisibility(isChangeFeedEntryVisible)` — row-level, for
  scope narrower than a whole table. Applied per entry, after the table
  filter, before anything is serialized — including a live `_events` signal.

Both are optional and independent; unregistered, both routes behave exactly as
before (tenant-scoped only). A hook that throws or returns something other
than the documented shape fails closed to "authorizes nothing" for that call —
same posture as a throwing `resolveDispatchTenantScope` resolver, and the same
200-empty-page shape the sensitivity filter above already gives a request
naming only tables it may not see (never a 5xx, which would tell a caller its
own hook is broken — indistinguishable from "denied" from the caller's side).

Every filter narrows the *returned* `changes`; nothing ever touches
`cursor`/`resyncRequired`/`resyncCursor` — mirrors the sensitivity filter's
"filters affect what is returned, never how the cursor advances" and for the
same reason: a client must advance past a denied entry without re-polling it
forever, and the entry's row id/timing must never be inferable from a stalled
cursor. Table denial passes a guaranteed-no-match sentinel table name rather
than an empty `tables` array, because `getChangesSince` treats an
omitted/empty `tables` as "no filter" and would otherwise widen the read; the
sentinel instead takes the ordinary `table_name IN (...)` path (the same one a
client naming a nonexistent table already took, unvalidated), so the real
horizon computation still runs and the cursor still advances — it just
matches zero rows.

`getAuthorizedChangesSince()` / `getAuthorizedTenantScopedChangesSince()` wrap
`getChangesSince()` / `getTenantScopedChangesSince()` with both hooks applied;
the generated `_changes` route calls the tenant-scoped variant, and
`buildChangeEventStream()` (`change-signals.md`) applies the same hooks to
`_events` catch-up replay and live signal delivery, resolving the table
allow-list ONCE at connection open (mirrors captured tenant scope).

## Compatible bulk mutations (#2818)

`appendChanges(db, entries)` validates all inputs before writing and returns one
sequence (or PostgreSQL staged `null`) per entry in input order. A nonempty batch
uses one client SQL statement and one set-based insert. The PostgreSQL
`_smrt_append_changes(jsonb)` helper chooses the staged/direct path once before
its own writes assign a transaction ID, and retains the same exception isolation
as the single-row helper. Bootstrap refreshes its body marker and runtime grants
include this exact helper signature.

The registered feed interceptor explicitly supports grouped lifecycle completion.
`recordInstanceChanges()` retains observable-table filtering, row/tenant IDs,
per-row operations, and best-effort failure handling. It publishes each direct
sequence in order; staged entries publish through the existing committed drain.
A batch is never replaced with a table-level bump or a single aggregate event.
The junction caller bounds its batch; the low-level append API does not split
one logical append into partially committed chunks.
