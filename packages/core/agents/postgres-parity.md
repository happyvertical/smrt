# Plebeos PostgreSQL parity

Run the same capability suites through SDK SQLite (default) and SDK PGlite:

```sh
pnpm --filter @happyvertical/smrt-core test:pglite
pnpm --filter @happyvertical/smrt-commerce test:pglite
pnpm --filter @happyvertical/smrt-app-runtime test:pglite
```

Build the workspace first. These commands set `SMRT_TEST_PGLITE=1`; they need no
services, containers or ports. Core/commerce `test:postgres` also run this matrix
after their server suites; runtime `test:postgres` runs its PGlite lane. The
runner reuses the browser QA peer fixture, installing the pinned SDK and PGlite
from its isolated lockfile. It leaves the workspace's browser dependency graph
unchanged. `getTestDatabase({ type: 'pglite' })` emits PostgreSQL DDL, including
native UUID identities/references and BIGINT integers, with fresh `memory://`
instances. `:memory:` is normalized only for that test adapter. An explicit file
URL still permits close/reopen tests. PGlite has PostgreSQL SQL/transaction
semantics but remains embedded for write serialization and revision fallback.

| Capability | SQLite | In-process PostgreSQL evidence |
| --- | --- | --- |
| Same-name app subclass | Full existing suite | Eager plain/STI/CTI, custom-column migration, REST/MCP, relationships, labels; UUID id and >int4 BIGINT hydration |
| One-hop labels | Full existing suite | Native UUID joins; opaque text references cast the target id; scoped list/get/search/sort/count, fallback, policy denials and ETags |
| Inline contacts | Full commerce suite | Atomic name/email/metadata-phone writes, rollback/retry, tenant isolation, no N+1 projections and absent optional metadata tables |
| Runtime exposure | Full existing suite | Live REST/MCP closures and tenant gates; retained handlers fail closed |
| Cookbook tools | Full existing suite | Eager enable/configure/apply, durable approval, initial empty-app shortcut, CAS/audit rollback; six lazy-specific cases intentionally SQLite-only |
| Owner approvals/continuations | Full existing suite | Real ApprovalService ledger, concurrent decision/consume, owner revalidation, expiry, settled observation, close/reopen and original caller/result |
| Lazy activation | Supported | Explicit refusal, before imports/DDL/readiness |
| Live app model editor/history | Supported | Explicit refusal, before history/DDL/host publication |

The `like` operator retains SQL LIKE semantics: SQLite's default ASCII folding
and PostgreSQL's case-sensitive comparison. This is the existing documented
operator contract, not an ILIKE claim. Case-insensitive portable search needs the
SDK query contract (sdk#1192), rather than regex rewriting generated SQL. Explicit
`NULLS FIRST`/`NULLS LAST` terms retain the existing bounded sort parser contract.

## Why live PostgreSQL activation remains refused

The process queue only serializes one process. PostgreSQL needs an advisory lock
covering **fresh schema inspection, planning, DDL and migration recording** on the
same connection; DDL and the completion marker must commit together, before
readiness opens. The current orchestrator inspects before the tracker transaction.
SDK 0.111.10 transaction handles and acquired sessions lack `getTableSchema()`;
using the pooled root for inspection while holding a transaction can inspect a
different snapshot or deadlock a one-connection pool/PGlite. Copying the SDK's
introspector or locking one session while doing DDL elsewhere is not a safe fix.

Needed: SDK transaction-bound schema inspection, then a public migration scope
that takes a bounded transaction advisory lock before diffing and atomically
applies the subset and tracker marker, with multi-session race/crash tests on a
real server. Existing int4 columns stay parity-equivalent to int8; live activation
must never run `db:migrate-int8`, which requires a maintenance window. Until then,
use eager registration plus operator-run `migrateSmrtSchemas`/`smrt db:migrate`
before serving PostgreSQL applications.

The app editor additionally replaces process-global registry state before
migration/publication and coordinates only through an in-process queue. It needs
cross-process revision fencing, pending-revision recovery and refresh of every
writer before opening new fields. SQL history portability alone would not make
that contract safe. Keep explicit editor/history refusal, and use static app
subclasses with ordinary migrations/restart for PostgreSQL custom fields/lists.
DuckDB live activation/editor remain refused; existing eager DuckDB support is
unchanged.

## Host boundaries

The complete template cookbook host explicitly refuses non-local profiles in
`host/server.ts`, before provisioning host state or onboarding. Its host audit
DDL uses SQLite AUTOINCREMENT and its shared-state user key is an empty-string
sentinel; those tables are not PostgreSQL-ready. Its onboarding/engine-selection
state and desktop/plugin credentials therefore remain **local SQLite only**.
A cloud host needs native UUID identities with an explicit sentinel migration,
PostgreSQL audit identity DDL, hosted owner/credential adapters, and the live
activation/editor work above. This slice does not change another worker's host,
preferences or inference credential paths. Recipe-tool setup logic is tested
through the eager PostgreSQL tool service, not claimed as a deployed onboarding
or plugin credential test.

## Reuse check

Read the intent index; MCP `review_smrt_project` on core, commerce, app-runtime
and template-sveltekit; MCP architecture context for PostgreSQL/PGlite testing,
activation locks, history and identifier validation. This server exposes context
and project inventories rather than separate component search. `rg` searched
smrt-ui, smrt-svelte, chat, core and the owning packages by name/purpose for
PGlite, database helpers, projections, inline writes, approvals, continuations,
SQL identifiers, migration sessions and onboarding storage.

No new production component/helper/model file was added. Extended the existing
test database, engine detector, memory-URL predicate/caches, cookbook identifier
validator and owner approval adapter. `createOwnerApprovalStore` is the existing
canonical adapter with a portable name; `createSqliteOwnerApprovalStore` remains
an alias. It reuses ApprovalService and core's serialized system-table bootstrap,
with native UUID hold identities on PostgreSQL. New test helpers reuse the existing browser fixture provisioner:
- `scripts/pglite-fixture.mjs` extracts the existing `provisionPglite` from
  `browser-entry-evaluation.mjs` for both browser and Node QA.
- `scripts/test-pglite.mjs` runs the ordinary package Vitest command with that
  isolated SDK factory, and cleans its temporary peer installation.

The same MCP/context and `rg` PGlite/helper/fixture queries found the provisioner;
no parallel database adapter or SQL implementation is introduced. The other new
file is this module doc.
Reserved person-created fields `order`, `group`, `from`, `to` are rejected with a
clear alternative-name message until sdk#1513 lands; the SDK is not patched here.

PGlite cannot verify server pools, independent backend advisory-lock contention,
network commit ambiguity, RLS deployment, LISTEN/NOTIFY, or real-server concurrent
index rollout. Keep the existing `test:postgres` lane for those server contracts.

## Change-specific test design

| Invariant / trigger | Positive / failure control | Actor/context | Executor/transaction | Runtime and contract edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| Independent memory handles open collections | Fresh system tables and one-hop sources in every handle; missing optional target yields fallback; real table errors propagate | Collection caller, null owner and two UUID tenants | SDK PGlite handles; no application DDL from reads | Node 26, SQLite/PostgreSQL, REST/collection SQL | Integration: core/commerce `test:pglite`, full default suites |
| Native identities and large integers | Subclass custom field migrated on its original table with completed durable markers; >int4 value remains a JS number; opaque display string stays TEXT | Same-name app/provider identities | Existing schema differ, atomic MigrationTracker and ordinary CRUD | SQLite/PostgreSQL, migration/REST/related-load | Integration: core `test:pglite` |
| Inline contacts and projections | Name/email/phone atomic update, one SELECT list/count; parent write failure rolls back contact/metadata; cross-tenant edits refuse | Tenant A × target owner A/B/null × ambient/explicit tenant | Ordinary `save()` transaction; profile metafield adapter bound to parent tx | SQLite/PostgreSQL, collection/REST input and projection | Integration: commerce `test:pglite` |
| Canonical owner holds and recovery | Approve/consume/record result once; concurrent resume has one winner; deny/expire never executes; restart uses original args/ceiling | Live owner, non-owner, foreign tenant/requester; active/inactive memberships | ApprovalService CAS/event transaction; SQL envelope result CAS | SQLite/PostgreSQL, authority/continuation | Integration: runtime `test:pglite` |
| Native hold storage | UUID id/tenant/gate columns; legacy TEXT identity table explicitly refuses | Trusted host adapter setup; no user-supplied schema | Existing serialized system-bootstrap scope; no application-table provisioning | PostgreSQL, portable adapter and compatibility alias | Integration: runtime `test:pglite` |
| Person-created SQL fields | Descriptive custom names remain valid; order/group/from/to rejected before journal mutation | Owner editor and cookbook importer | Browser-safe validation before DDL/history | All engines, cookbook import/editor tools | Unit/integration: models + app-model-editor in core suites |
| Unsupported live DDL | SQLite activation/editor retain full recovery coverage; real PGlite refuses without queries, imports or host publication | Host coordinator/editor; no tenant authority gained by readiness | No SQL on refusal | PostgreSQL; no readiness, history or application schema mutation | Integration: activation + app-model-editor `test:pglite` |

Before the cache fixes, PGlite projection/commerce suites failed on absent tables
and same-name subclass REST deletion failed with HTTP 500 after a previous handle
had bootstrapped system tables. Fresh `memory://` handles now keep separate caches;
the exact missing-table, policy-error, inline-write and CRUD regressions pass.
Evaluating the baseline validator reproduced acceptance of reserved `to`; the
reader and JSON Schema now both reject it. Other reserved names retain their prior rejection coverage.

The subclass matrix applies generated DDL through the existing atomic migration
tracker. Its PostgreSQL regression initially failed because the nested tracker
dropped the resolved engine and created SQLite-style timestamp columns. Passing
the resolved engine into that tracker preserves PostgreSQL DDL and completion
markers inside the same transaction; the identical regression now passes.


Validation coordination: after editing package manifests, complete one
`pnpm install --frozen-lockfile` before other pnpm commands. pnpm's automatic
dependency refresh can run prepare/build scripts even for a read-only command;
overlapping Turbo or pnpm invocations can then remove declarations or package
staging files another invocation is using. Run final build, knowledge generation,
test and typecheck commands serially; do not skip hooks or change toolchains to
hide those failures.

The initial global PGlite dev dependency failed bundle-gate's unchanged browser
reachability test by exposing the peer's guarded Node fallback imports. Reusing
the documented isolated browser peer fixture fixes the dependency boundary; no
audit exemption or weakened test was added. The browser execution fixture still
uses the same peer/WASM import map and now shares its provisioner with Node QA.

Drive-by fix: root `turbo.json` includes package `scripts/**` in build inputs,
because core copies those scripts into dist. Changes to the shared fixture
runner must invalidate that copied artifact. The provisioner also rejects an
isolated SDK pin that differs from the installed workspace SDK.

Measured opt-in lane durations on Node 26.8.1/pnpm 11.25.0 with other workers
active: core 63.96 s (107 passed, 7 intentional lazy-only skips), commerce
35.86 s (18 passed), runtime 23.75 s (17 passed): 123.57 s combined. The default
suite performs no PostgreSQL/WASM startup; its extra checks are validation,
cache-identity and compatibility-alias regressions. The unchanged browser
boundary suite passes 3/3; core's full browser command also passes plain JSON,
503-export evaluation, real PGlite cascades on memory/idb and unbundled Vite dev.
