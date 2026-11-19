# App-owned fields and lists (A4)

Node-only public entry: `@happyvertical/smrt-core/app-models`.
`await createAppModelEditor(options)` is the single programmatic editor.
The shared [app tools](app-tools.md) adapt human labels for MCP/assistant use.
Await construction before serving:
it replays persisted definitions and completes any pending activation.

## Source and API

Cookbook v1 optionally carries:

```json
{
  "models": {
    "version": 1,
    "packageName": "@studio/app",
    "lists": {
      "LoanerMat": {
        "label": "Loaner mats",
        "icon": "layers",
        "displayField": "size",
        "fields": {
          "size": { "type": "text" },
          "condition": { "type": "choice", "choices": ["new", "used"] },
          "customerId": {
            "type": "reference",
            "target": "@happyvertical/smrt-customers:Customer"
          }
        }
      }
    },
    "fields": {
      "@happyvertical/smrt-customers:Customer": {
        "preferredInstructor": { "type": "text" },
        "loanerMatId": { "type": "reference", "target": "LoanerMat" }
      }
    }
  }
}
```

The surrounding cookbook still requires its normal schema/version/recipes/
features/policies. New lists are enabled through qualified `features`.
`models.fields` names the provider; registration makes its same-name app
subclass effective, retaining the provider's table, methods, exposure and
tenancy. An existing same-name app subclass is refreshed. New `models.fields`
declarations need their provider in the app (`MODEL_NOT_IN_APP` otherwise).
Disabling a provider's last recipe keeps its journalled declarations, inactive:
they are not registered (a replacement this editor added leaves the registry),
migrated or held closed, the provider need not be
loaded (a lazy host's restart), and enabling the recipe again restores the
fields with their stored data. A journalled reference field among them is
resolved again only when the recipe returns. Their app-scope policies (labels) are pruned
with the recipe like any other policy of an uncovered model.

Field types: `text`, `longText`, `integer`, `decimal`, `money` (requires
`currency: "CAD"`), `date`, `datetime`, `boolean`, `choice` (requires
`choices`), `reference` (requires qualified enabled app model or list name).
Money stores a safe integer in minor units and a companion
`<field>Currency` text column. Safe integer/finite decimal/choice/reference
validators apply to the record's normal save executor. References use the
owning collection and ambient tenancy; they cannot point at another tenant's
row. Reference targets must already be enabled or declared in this cookbook.
Lists are tenant scoped. Provider tenancy is preserved.

Options require `db`, `application`, `tenantId`, `packageName`, initial
`cookbook`, the existing engine `catalog`, and an async/sync
`authorize(context)`. Identity comes from host authentication. Schema
definitions belong to the application runtime: the host must not run
independently customized application registries in the same global registry.
This is enforced: once one editor's journal (application + tenant) has
registered customisations, constructing (also concurrently), snapshotting or
editing through an editor for another journal in the same process fails
`MODEL_EDIT_CONFLICT` instead of merging or projecting fields and lists
between them. Reopening the same journal is allowed. The journal identity is application,
tenant and database: the database URL, so a new handle to the same database
(a reconnect) reopens the same journal; an in-memory or URL-less database is
identified per handle. Runtime exposure admits a registration the editor made
(its lists and provider replacements) only for that journal's tenant, so a
pre-opened tenant is never served another tenant's customised provider over
REST or MCP. A context without a tenant (a generator built once, tenancy
resolved per request) is treated as single-tenant and admitted; a host serving
several customised tenants must pass the tenant in its exposure or generator
context. A replacement is taken out on disable by any editor instance of the
journal that made it, restoring the registration it replaced and dropping its
ownership; a failed edit restores ownership with the registry.
Serve each further customised tenant from its own process.
Rows retain the existing tenancy interceptor; install it as for normal models.

`editor.apply(edit, { actor, tenantId, requestId, expectedRevision })` supports:

- `add_field { model, name, field, label? }` (atomic initial policy label).
- `label_field { model, name, label }` (null resets).
- `hide_field { model, name, hidden }` and `remove_field { model, name }`.
- `create_list { name, list, fieldLabels? }`, `relabel_list { name, label, icon? }`,
  `remove_list { name }`.
- `import { cookbook }`, `undo`.

For list fields, `model` is the simple list name or its qualified app identity.
Provider and effective app identities are accepted for override policies.
Each edit may carry an optional `summary` caption persisted in its command.
`relabel_list` also accepts a qualified enabled provider model and updates its
cookbook navigation labels/icons, including keyed entries.
Labels and hiding use existing cookbook `policies`; no parallel label/hidden
metadata is added. Removing a list disables its feature. Removing a field hides
it (and its money companion). No operation drops columns/tables or data.
Field type/target/choice changes and explicit purge are deliberately rejected/
unavailable; they need a separate data migration contract.

`snapshot()` returns revision, cookbook, runtime manifest and web definitions.
`export()` returns normal cookbook JSON, accepted by existing engine import
and the editor's import operation; package identity must match.
`history()` returns ordered durable revisions; `subscribe(listener)` observes
committed publications. Receipt `elapsedMs` measures journal append through
migration and awaited publication (completion bookkeeping excluded).

Every derived table and column name, a money field's `_currency` companion
included, must fit PostgreSQL's 63-byte identifier limit (the strictest
supported engine; `MAX_STORAGE_IDENTIFIER_BYTES`), checked in bytes when an edit
or import adds it: `INVALID_MODEL_EDIT` names the path, the derived identifier
and its size. The app tools shorten a long label's derived name to fit and keep
the full label for display. A declaration journalled before this check is still
accepted, and an applied journal reopens without DDL (the boot's storage
check compares truncated names); on PostgreSQL a migration of a table holding
such a truncated column is refused up front with `MODEL_MIGRATION_REQUIRED`
(instead of failing on a duplicate column) while edits of other models stay
available.
Reserved field names live in one place, `src/cookbook/reserved-names.ts`:
JS/SQL/framework column names, every `SmrtClassOptions`/`SmrtObjectOptions`
key (constructor input mixes options with field values) and every own instance
property of a constructed `SmrtObject` (`options`, …). A new field, or its money
companion, may not take one, nor a prototype member of its model; a field the
journal already holds stays accepted. The app tools prefix a reserved label's
derived name (`Options` → `customOptions`).
Names use bounded ASCII camel/Pascal identifiers. Reserved JS/framework/SQL
names, inherited fields/methods, duplicate storage names, table/model
collisions and disabled reference targets fail before history mutation.
A new list's name is checked against every installed catalog model, loaded or
not, and its table against registered models and the tables the database
already keeps (a disabled recipe's retained table). Lists the journal already
holds keep their name and table, so editing or removing one never depends on
what else is loaded. List tables are unique across the database: a list
whose table another journal (another application or tenant) declares, or that
already exists, is refused with a neutral `MODEL_TABLE_COLLISION` that names
no other tenant's list. A catalog model with exactly the list's identity is
refused too. The activation coordinator reads the journal itself, so no recipe
loads onto a journalled list's table, whatever the boot order.
Optimistic revisions and request ids reject stale/racing edits and mismatched
retries; identical committed requests replay.

## Host publication and activation

Bind `publish(snapshot)` once to the host's existing cookbook engine and
manifest/web-definition store. This callback is awaited while affected models
are closed. For example, construct a fresh `createCookbookEngine({ catalog,
cookbook: snapshot.cookbook })` and replace the host engine pointer. Keep
`createCookbookRuntimeExposure({ catalog, engineFor })` resolving that pointer
for the authenticated tenant. Serve new list routes through the existing
`APIGenerator.generateHandler()` catch-all and render the supplied definitions
with the host's existing screens. The editor does not rewrite static SvelteKit
route files or already-imported AOT web modules; such a host needs this dynamic
binding before using the API.

When also using A3 lazy activation, pass the coordinator to the editor as
`activation`. A new list's name and table are then also checked against the
activation manifest's models and tables (installed, loaded or not), and
`import` and `undo` activate every model the restored cookbook covers (custom
lists aside) before the edit applies. Admission comes first: a refused caller,
a stale revision or a replayed request id loads nothing. Activation failure is
`MODEL_ACTIVATION_FAILED` with nothing journalled.
With lazy activation, the tool service hands its `activation` to
`editor.apply(edit, context, { activation })` for `app.undo`,
`recipes.enable` and template apply, so the editor activates the restored
recipes only after its own authorization, replay lookup and durable revision
check; failure is `activation_failed` with nothing changed.
When also using A3 lazy activation, boot the installed/provider graph first.
Its fixed-graph `readEnabled` input excludes only custom-list identities declared
in the validated cookbook's `models.lists`; unexpected unknown ids must still
fail. Then await this editor before serving. `ActivationCoordinator.isReady()`
recognizes editor-managed readiness via the public
`getRuntimeModelReadiness()`, so its composed tenant gate admits a custom list
only after the editor's tracked migration and journal completion. Runtime
definitions remain cookbook data, outside the fixed source-module graph.

Every operation uses the running process:

| Operation | Activation |
| --- | --- |
| Add list / field; import | Register/refresh runtime definitions, same-name replacement (STI and CTI), tracked migration of the changed models' tables, publish, release readiness |
| Boot replay | Register/refresh every journalled definition, no DDL ever; read-only check that every customised table holds its declared columns, else `MODEL_MIGRATION_REQUIRED` with those models closed (a pending revision completes only once its storage is in place); publish, release readiness. Repair with `migrateAppModelStorage(options)`, which reconciles every active customised table from the journal |
| Field label/hide/remove | Existing policy engine, same publication protocol; migration reconciliation is normally empty |
| List relabel/remove | Runtime presentation refresh / feature removal, same publication protocol |
| Undo | Restore previous cookbook, keep union of historical storage fields hidden, tracked additive reconciliation, publish |

No rebuild/restart/source-generation fallback is used by supported SQLite and PostgreSQL
operations. Runtime REST and MCP regenerate from the registry; CLI command
options invalidate on registry generation. Assistant provider schemas use
the existing MCP/provider schema conversion. Runtime manifest hashes,
relationship/display metadata and web definitions use the normal projection.
The exposure gate admits cookbook custom lists and denies pending/removed
models. Unused applications retain the previous behavior.

Provider replacements retain linked display labels and the provider's curated
`display.list` order. The editor's web projection appends visible custom fields
to that list without changing the provider configuration; hidden/removed fields
remain in storage but are omitted from the projected list. Runtime manifests
carry the physical table binding even when a decorator leaves it implicit, so
same-name replacement selection emits one effective web definition.

REST auto-discovery resolves a collection declaration to its effective row model
before activation/exposure checks, authorization, collection construction and
CRUD dispatch. Collection registration order must not change those decisions;
sync target discovery uses the same resolver. This retains the ordinary tenant,
API-operation and cookbook gates rather than admitting a collection separately.

| Regression / boundary | Positive evidence | Negative controls | Executor / scope |
| --- | --- | --- | --- |
| Recipe field edit with collection-first registration and implicit table | Both trusted design `app.addField` and direct `editor.apply`; provider and existing same-namespace app replacement; GET/list/PUT preserve the original row, linked name and custom value | Closed delete, foreign tenant, pending or missing readiness, disabled recipe | Existing `cookbook/app-tools.test.ts`, SQLite and prepared in-process PGlite |
| Curated presentation and journal reopen | One effective definition; original column order followed by custom column; revision replay retains REST record/value | Hidden custom column omitted; no duplicate provider definition | Same four-case matrix; registry restored to provider state before editor reopen |

SQLite registers the candidate and checks the edited tables for manual drift
before appending its pending revision, so a refused migration leaves no journal
row and restores the registry and readiness. A failure after the append (DDL
execution or host publication) keeps affected models closed and recovers the
pending work on reopen.
PostgreSQL claims the revision and migrates application columns plus the tracker
marker in one advisory-locked transaction, using transaction-bound inspection.
DDL failure rolls back the history insert and registry registration, restores
readiness, and permits the same request to retry. After commit, host publication
runs while models remain gated; a publication failure stays durably pending and
reopen completes that revision. No columns/tables are dropped. Reconciliation
selects the tables of models whose stored fields the edit adds or changes, and
their existing physical FK closure; label, hide, remove, relabel and undo edits
run no DDL, and drift on an unrelated table never blocks an edit. Boot runs no DDL at all, for an applied journal, a pending revision or a
startup cookbook: provider tables stay the operator's `db:migrate`, and app
storage (custom fields and lists, including one lost in a restore) is
reconciled from the journal by `migrateAppModelStorage(options)`. Boot inspects every customised table read-only and refuses with
`MODEL_MIGRATION_REQUIRED` (naming the missing columns, affected models kept
closed) when a column is missing, for example after a provider upgrade or a
database restore; run `migrateAppModelStorage` (custom storage) or `smrt db:migrate` (provider columns) and reopen. Manual drift on an
edited table still requires an operator migration. See the
[PostgreSQL scope and test matrix](postgres-parity.md).

## Durable history

`AppModelHistoryStore` has `read()`, atomic
`append(change, expectedRevision)`, `complete(revision, elapsedMs)` and the
optional `abandon(revision, { actor, reason? })`.
A pending revision that can never complete (its migration keeps failing, or
its publication target is gone) is abandoned by an operator with
`abandonAppModelRevision({ db, application, tenantId, revision, actor, reason? })`
while no editor for that tenant is serving; boot names it in its error. The row
stays for audit: it is completed with its `before` document as `after`, read
back with `abandoned: true`, never replayed (a retry of its request id fails
`MODEL_REVISION_ABANDONED`), never an undo target, and its `undoes` never
counts as a reversal. An editor whose completion loses to an abandon fails
`MODEL_EDIT_CONFLICT` and stays closed. Nothing is dropped.
Editor reads are bounded: each stored receipt holds a full projection, so with
a store made by `createAppModelHistory` (or a wrapper keeping its `read`) the
editor reads the journal once at boot without receipts, keeps it in memory, and
per edit reads only the latest row and the row for its request id; other
stores fall back to `read()`. After `complete` the editor reads its row back:
if another process completed the revision first it installs that receipt
through `publish` before readiness opens (staying closed if that fails) and
serves it from `snapshot()` (a winner whose installation failed is remembered per journal, so
reopening installs its manifest and web definitions even when its cookbook matches), and if the row is not applied it fails `MODEL_EDIT_CONFLICT` and
stays closed instead of reporting success.
A supplied host store must scope reads/writes to one app/tenant and preserve
the pending/CAS contract. PostgreSQL stores must also implement
`transaction(work)` with a scoped store/executor, so revision CAS and DDL share
one locked transaction. Completion is fenced; a concurrent/stale edit gets
`MODEL_EDIT_CONFLICT` and must refresh/reopen. The default
`createAppModelHistory()` (`createSqliteAppModelHistory` remains an alias) migrates
`_smrt_app_model_changes` through `MigrationTracker`, with composite
app/tenant/revision primary key and app/tenant/request uniqueness. History is
permanent. Undo appends a compensating revision for the latest not-yet-undone
edit; it never deletes history. The persisted cookbook is authoritative over
the startup default. A startup cookbook that declares app models, opened with an empty
journal, is journalled as revision 1 (actor `system`, an `import`). Its own
declarations may have booted before this release, so they count as existing
for the name, length and reserved-name checks; its lists still may not take a
table an installed model owns (activation manifest or registry), retained or
not. Boot does not create its tables and never adopts an existing one: with an empty journal a plain
`createAppModelEditor` refuses a startup cookbook that declares models before journalling anything
(`MODEL_TABLE_COLLISION` for a list whose table exists, `MODEL_MIGRATION_REQUIRED` otherwise), so
no revision is left pending. `migrateAppModelStorage(options)` journals it, creates its tables (or
adopts one the operator confirms is its own storage), once, as the operator step that opens such a
host. A pending startup revision is never offered for `abandonAppModelRevision`, which would drop the
startup models. Its lists may not take the identity
of an installed app model in the manifest, nor a table another journal's list
declares (another application or tenant on this database). Export contains portable definitions/policies, not host
actor/history records.

SQLite and PostgreSQL are supported. PostgreSQL history stores native UUID
tenant ids and JS-safe BIGINT revisions/durations. Existing int4 application
columns remain equivalent to int8; automatic widening is forbidden. DuckDB
still lacks this transaction-bound inspection/history and live-DDL rollback
scope. Cross-process registry/engine broadcasting, purge, automatic static-host
conversion and packaged desktop timing are not implemented. Hosts refresh each
process from durable revisions; the database CAS fences stale writers.

## Evidence and reuse

In-process SQLite/PGlite fixtures: real tenant-scoped provider constructor, app
same-name subclass, existing REST handler/MCP generator, real tenancy
interceptor, and a disk database reopened after failed publication.
Historical SQLite-only targeted run: fields 1.5–7.8 ms, list create 2.3 ms, relabel 2.2 ms,
remove 1.6 ms, field policies 0.8–1.4 ms, boot replay 1.4 ms, undo 0.9 ms
and import 1.1 ms. These are fixture measurements, not
desktop performance guarantees; receipts let the host measure its own work.

| Risk | Executable evidence |
| --- | --- |
| Wrong schema/transport | Every field type REST round-trip on provider CTI table; live MCP/provider schema and web definition; warmed CLI cache refresh |
| Lost data/revisions | Label/hide/show/remove/undo, money companion, file restart and pending recovery, fresh database export/import |
| Authorization | Owner/tenant rejection, reference and row isolation using actual tenancy interceptor, stale revision/request reuse |
| Unsafe metadata | Reserved/collision rejection, reader/JSON Schema agreement, unchanged legacy cookbook |
| Exposure drift | Removed list REST denial, undo reopen, failed publication gate, normal cookbook engine publication |

Reuse discovery used smrt-dev-mcp project reviews for core/types/CLI and
architecture context for custom fields, runtime models, cookbook history and
app replacement; read the intent index and searched core/smrt-fields/
smrt-ui/smrt-svelte/chat by name and purpose. New files:

- `src/cookbook/models.ts`: extends existing cookbook validator/catalog,
  naming rules and shared types; no previous portable app-model section.
- `src/cookbook/model-history.ts`: uses migration definitions/tracker.
  Existing engine journal is in-memory; `runOnce` cannot span recoverable
  registration/publication. No durable reversible model journal existed.
- `src/cookbook/model-editor.ts`: orchestrates runtime registration,
  subtype replacement, migration orchestration, cookbook policy commands,
  web projection and exposure gate. No prior editor owned this lifecycle.
- `src/app-models.ts`: Node export entry only; no duplicate implementation.
- New core/CLI test files introduce fixtures only; no new application model
  or UI component.

The readiness getter extends the existing runtime-exposure state rather than
adding an activation store. Reuse searches: MCP architecture context
“runtime readiness query / ActivationCoordinator.isReady”, and rg
`getRuntimeModelReadiness|isRuntimeModelReady|isReady` across core/UI/Svelte/chat:
only the fixed-graph coordinator had a readiness query.

Shared source files touched (relative to core `src/`):
`runtime-model.ts`, `runtime-exposure.ts`, `activation.ts`, `registry.ts`,
`registry/class-registration.ts`, `registry/validator.ts`, `collection.ts`,
`generators/rest.ts`, `cookbook/validate.ts`, `cookbook/v1.schema.json`,
and `cookbook/engine/{commands,document,engine,nav,types}.ts`.
Outside core: shared cookbook types/exports in `packages/types`, CLI command
cache in `packages/cli/src/cli-generator.ts` with its test/documentation,
and generated core/CLI knowledge pages. No other package implementation changes.

### Historical receipts and durable tool results

The existing journal's v2 migration adds optional operation, receipt and result
JSON columns. New completions persist the exact historical receipt; durable host
operations additionally persist their exact tool response. First completion is a
pending-only CAS: repeated/concurrent completion cannot replace the winning
projection, timing or result. Pending boot recovery completes the original
operation using its pinned catalog and captured manifest identity mapping, then
stores the response before readiness opens. Completed replay never rebuilds a
response from live registry/catalog state. Ordinary pre-v2 rows retain their
legacy snapshot replay fallback; durable operations refuse missing verified data.

Custom stores opt into `supportsDurableOperations` only when they atomically retain
operation metadata at append and the first receipt/result passed to `complete`.
`editor.recover(context)` rechecks authorization, tenant, actor, original revision
and operation binding before returning a verified completed journal row. The
matching `application` and capability getters support trusted host adapters.
