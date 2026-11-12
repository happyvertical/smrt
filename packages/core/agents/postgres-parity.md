# Plebeos PostgreSQL parity

Build first, then run the same capability suites through SDK SQLite (default)
and SDK PGlite (real PostgreSQL in process):

```sh
pnpm --filter @happyvertical/smrt-core test:pglite
pnpm --filter @happyvertical/smrt-commerce test:pglite
pnpm --filter @happyvertical/smrt-app-runtime test:pglite
```

These opt-in commands need no services, containers or ports. Core/commerce
`test:postgres` append this matrix to their server suites; runtime uses it as
its PostgreSQL lane. The runner reuses the isolated browser peer fixture and
its pinned SDK/PGlite lockfile, preserving the workspace's browser dependency
boundary. It checks that the SDK pin matches the workspace. Default tests do
not load PostgreSQL/WASM. Fresh `memory://` handles have separate caches;
explicit file URLs support close/reopen recovery.

| Capability | SQLite | PostgreSQL in-process |
| --- | --- | --- |
| Same-name app subclass | Pass | Eager and lazy plain/STI/CTI, custom-column migration, REST/MCP, labels and relationships; native UUID and >int4 BIGINT hydration |
| One-hop labels | Pass | Native UUID joins, opaque text references, scoped list/get/search/sort/count, fallback, policy denials and ETags |
| Inline contacts | Pass | Atomic name/email/phone writes, rollback/retry, tenant isolation and bounded list projections |
| Runtime exposure | Pass | Live REST/MCP tenant gates and retained-handler refusal |
| Cookbook tools | Pass | Eager and lazy enable/configure/apply, owner holds, empty-app shortcut, CAS/audit failure and retry |
| Owner approvals/continuations | Pass | Canonical ApprovalService, concurrent decision/consume, owner revalidation, expiry, restart and original-caller result |
| Lazy activation | Pass | Fresh transaction-bound inspection, atomic subset DDL/marker, concurrent first use, rollback/retry and restart |
| App editor/history | Pass | Every field type, list/reference CRUD, label rename, hide/remove, ordered history, undo/import/restart, revision fencing and pending publication recovery |
| Durable design Apply | Pass | Real cookbook tool Apply, canonical native review holds, transaction-bound operation/receipt/result persistence, exact replay after later edits, owner/tenant/content checks and rolled-back DDL retry |
| Hosted onboarding/credentials | Local-only host | Outside this feature; the host intentionally remains local-only |

SQL `like` retains its existing semantics: SQLite ASCII folding versus
PostgreSQL case-sensitive LIKE. Portable ILIKE requires the SDK query contract
(sdk#1192), not rewriting SQL. Explicit NULLS FIRST/LAST remains supported.
Person-created `order`, `group`, `from`, `to` fields are rejected with descriptive
alternatives until sdk#1513; the SDK is not patched here.

## PostgreSQL migration scope

`schema/inspection.ts` exports `inspectTableSchema(db, table, engine)` through
`./schema`. It reuses a supplied public adapter inspector. PostgreSQL transaction
handles without that method read pg_catalog through their own `query()`:
columns/defaults/primary keys, ordered indexes/predicates and FK actions. Names
are parameters in the transaction fallback, including quoted identifiers, within
the existing public-schema migration contract. Adapter inspectors retain their
own identifier validation.
No pooled/root handle is borrowed to inspect uncommitted DDL. SchemaComparer
uses this fallback; table/predicate catalogs retain their public-schema scope.

Activation imports and validates its declared closure in the existing process
queue. PostgreSQL then uses `runSerializedAgainstSystemTableBootstrap` for a
bounded transaction advisory lock. The **fresh diff**, ordinary transactional
DDL and MigrationTracker completion marker use that same connection. Readiness
opens after commit. Independent coordinators re-diff committed tables and do not
reapply DDL. Failed DDL rolls back the application subset and its marker; retry
reuses loaded modules. Runtime record initialization still checks tables only.

Live migrations use `atomic: true`, `postgresSafe: false` and ordinary indexes;
CONCURRENTLY cannot run in this transaction. Eager/operator migration defaults
remain unchanged. Manual drift still refuses before DDL. Existing int4 columns
remain parity-equivalent to int8: the restart test verifies they are not widened.
`db:migrate-int8` remains an explicit maintenance-window operation. Live changes
never invoke it. Operators must coordinate maintenance migrations with writers.

## Revision fencing and recovery

The existing journal factory is now `createAppModelHistory`; the old
`createSqliteAppModelHistory` name is an alias. PostgreSQL history has a native
UUID tenant identity, BIGINT revisions/durations and application/tenant-scoped
revision/request keys. Integer reads are JS-safe; PostgreSQL durations are rounded
to whole milliseconds. Existing TEXT-identity PostgreSQL tables require an
explicit validated migration rather than runtime type conversion.

`AppModelHistoryStore.transaction(work)` binds a scoped store and executor to the
same locked transaction. PostgreSQL custom stores must provide it; otherwise
creation reports `MODEL_HISTORY_TRANSACTION_REQUIRED`. The editor claims the
expected revision with the existing INSERT/SELECT CAS before changing registry
state. That claim, the schema change and migration marker commit together. A
stale/concurrent editor receives MODEL_EDIT_CONFLICT, never a raw uniqueness
error, and must reopen/refresh before editing again.

`withRuntimeSchemaActivation` reuses activation's process queue for editor
registration/DDL/publication. `ObjectRegistry.checkpointRegistrations` rolls back
only the edited identities and lineage after failed PostgreSQL DDL, retaining
unrelated classes and restrictive consumer policies. Readiness and editor state
are restored; the same failed request can retry because its journal insert also
rolled back. Tests inject a real PostgreSQL error after earlier DDL statements
and verify no new field, revision or completed marker survives. A separate boot
commit-failure regression verifies registry restoration after the callback has
already succeeded; it also restores the prior readiness of provider and app identities.

After schema commit, affected models stay gated while the host's existing
`publish` callback runs. A callback failure leaves durable **pending** history;
reopening replays it, completes the same revision and opens readiness. No host
callback runs before the DDL transaction commits. Completion is fenced against
a newer revision. This deliberately preserves the SQLite publication/recovery
contract; SQLite retains its existing append-before-migration journal behavior.

Schema edits are additive: rename changes a human label; hide/remove/undo keep
stored columns/tables and data. Stored identifier/type changes and purge still
need an explicit data migration contract. The SQL fence coordinates writers in
other processes; it does not broadcast registry or host-engine projections.
Each serving process must reopen/refresh from durable history before adopting a
new revision. A stale writer is refused. Independently customized apps must use
separate registry namespaces/processes, as on SQLite.

## Remaining boundaries

DuckDB lazy activation/editor are explicitly refused. They have no implemented
transaction-bound inspection/history scope or validated live ALTER/rollback
coordinator here; PostgreSQL pg_catalog/advisory SQL cannot provide those
contracts for DuckDB. Existing eager DuckDB behavior is unchanged.

Hosted onboarding and credentials remain outside scope: the template host is
local-only by design. No hosted storage/credential adapter is introduced.

PGlite verifies SQL, transactions and durable files, but cannot establish
independent backend/pool lock contention, network commit ambiguity, deployment
RLS, LISTEN/NOTIFY or real-server concurrent index rollout. Those still require
real PostgreSQL server coverage; none is claimed by this matrix.

## Test design and reuse

| Invariant / reachable trigger | Positive / failure control | Actor/context; executor | Runtime / contract edge; level | Validation |
| --- | --- | --- | --- | --- |
| Transaction inspection | Uncommitted CREATE/ALTER visible; rollback removes schema; quoted table, FK/index and bound hostile name | Migration caller; supplied transaction only, pooled query/inspector spies throw | PGlite / SchemaComparer; integration | core test:pglite |
| First recipe use | Same-name closure ready once, overlapping/equal calls coalesce, independent coordinator rechecks | Two tenant gates; shared process queue and locked tracker transaction | SQLite/PGlite / REST, MCP and recipe tools; integration | core test:pglite and default tests |
| Activation failure/retry | Later CREATE fails after earlier tables; entire subset rolls back, gate stays shut; retry succeeds | Enabled owner; real transaction and retained loaders | SQLite/PGlite / readiness; integration | activation + tools suites |
| Native storage | UUID ids/FKs and BIGINT field/history columns; >int4 value hydrates safely; legacy int4 stays int4 | Tenant-scoped records; normal save executor and transaction inspection | SQLite/PGlite / schema and REST; integration | subclass + editor suites |
| Editor revision fence | Concurrent editors have one winner; an intervening store writer is caught inside the DDL transaction | Owner × correct/foreign tenant × reader; scoped history CAS and migration executor | SQLite/PGlite / apply/history; integration | editor + customization-tool suites |
| Editor DDL failure | SQL error after ALTER leaves no field, history revision or marker; same request retries | Authorized owner; checkpointed registry and one transaction | PGlite / DDL, authority and retry; integration | editor suite |
| Publication recovery | Failed callback remains gated/pending; file reopen completes the original revision | Host callback; commit first, then publish/complete | SQLite/PGlite / durable host publication; integration | editor recovery suite |
| Restrictive metadata | Rollback restores lineage and preserves unrelated classes/new denials | Trusted consumer tightening policy during staged registration | Both engines (no SQL) / registry authority; unit | runtime-overrides suite |
| Unsafe field names | Descriptive names pass; reserved/colliding names fail before history/DDL | Owner editor/importer; existing validator | All engines / JSON Schema and editor; integration | models + editor suites |

Reuse discovery: MCP `review_smrt_project` on core and architecture context for
transaction-bound inspection, advisory locks and history/revision CAS; intent
index; `rg` by name and purpose across core, smrt-ui, smrt-svelte and chat. The
SDK exposes TableSchemaInfo but exports no query-only inspector for transaction
handles. Existing live-parity catalogs do not return that table-schema contract.
The new `src/schema/inspection.ts` supplies that missing owning-layer seam for
the existing comparer; `inspection.test.ts` reuses getTestDatabase and real SDK
transactions. Other changes extend existing modules: bootstrap locking, tracker,
history CAS, runtime registration, policy/lineage ownership and activation queue.
The scoped production checkpoint preserves authority/unrelated state; the broad
Vitest-only snapshot/reset helper remains test isolation. No parallel model,
route, component, approval ledger or database adapter is added.

The two positive PostgreSQL startup/editor tests were executed with their
integration-base implementations: both failed with the old explicit refusals.
The same cases pass with transaction inspection and revision fencing enabled.

The core `test:pglite` script includes `cookbook/app-tools.test.ts`, including the
host-owned `designAction` path rather than only programmatic editor edits. The
scoped history store retains its durable-operation capability; PostgreSQL
completion forwards the original receipt and tool result under the revision
fence. Its immutable first completion and recovered pending publication obey
the same native-approval protocol as SQLite. These in-process assertions do not
establish independent-backend contention or network commit reconciliation.
