# App-owned fields and lists (A4)

Node-only public entry: `@happyvertical/smrt-core/app-models`.
`await createAppModelEditor(options)` is the single programmatic editor.
No UI or assistant edit tool is included. Await construction before serving:
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
tenancy. An existing same-name app subclass is refreshed.

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
Rows retain the existing tenancy interceptor; install it as for normal models.

`editor.apply(edit, { actor, tenantId, requestId, expectedRevision })` supports:

- `add_field { model, name, field }`.
- `label_field { model, name, label }` (null resets).
- `hide_field { model, name, hidden }` and `remove_field { model, name }`.
- `create_list { name, list }`, `relabel_list { name, label, icon? }`,
  `remove_list { name }`.
- `import { cookbook }`, `undo`.

For list fields, `model` is the simple list name or its qualified app identity.
Provider and effective app identities are accepted for override policies.
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

Names use bounded ASCII camel/Pascal identifiers. Reserved JS/framework/SQL
names, inherited fields/methods, duplicate storage names, table/model
collisions and disabled reference targets fail before history mutation.
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

Every operation uses the running process:

| Operation | Activation |
| --- | --- |
| Add list / field; import; boot replay | Register/refresh runtime definitions, same-name replacement (STI and CTI), tracked migration, publish, release readiness |
| Field label/hide/remove | Existing policy engine, same publication protocol; migration reconciliation is normally empty |
| List relabel/remove | Runtime presentation refresh / feature removal, same publication protocol |
| Undo | Restore previous cookbook, keep union of historical storage fields hidden, tracked additive reconciliation, publish |

No rebuild/restart/source-generation fallback is used by supported SQLite
operations. Runtime REST and MCP regenerate from the registry; CLI command
options invalidate on registry generation. Assistant provider schemas use
the existing MCP/provider schema conversion. Runtime manifest hashes,
relationship/display metadata and web definitions use the normal projection.
The exposure gate admits cookbook custom lists and denies pending/removed
models. Unused applications retain the previous behavior.

A pending revision is appended before registration/DDL. Both application
columns and the optional history table use the migration tracker. Manual
schema drift refuses activation. After successful migration/publication,
the journal completes and readiness opens. A failure may have committed
additive DDL: affected models stay closed, the revision stays pending, and
reopening the editor retries idempotently. The API does not promise that the
old schema keeps serving through a failed activation.

## Durable history

`AppModelHistoryStore` has `read()`, atomic
`append(change, expectedRevision)` and `complete(revision, elapsedMs)`.
A supplied host store must scope reads/writes to one app/tenant and preserve
the pending/CAS contract. The default `createSqliteAppModelHistory()` migrates
`_smrt_app_model_changes` through `MigrationTracker`, with composite
app/tenant/revision primary key and app/tenant/request uniqueness. History is
permanent. Undo appends a compensating revision for the latest not-yet-undone
edit; it never deletes history. The persisted cookbook is authoritative over
the startup default. Export contains portable definitions/policies, not host
actor/history records.

SQLite is the supported editor backend. PostgreSQL/DuckDB activation,
cross-process registry propagation, purge, automatic static host conversion,
and packaged desktop timing are not implemented/verified.

## Evidence and reuse

In-process SQLite fixture: real tenant-scoped provider constructor, app
same-name subclass, existing REST handler/MCP generator, real tenancy
interceptor, and a disk database reopened after failed publication.
Local targeted run: fields 1.5–6.2 ms, list create 2.3 ms, relabel 2.2 ms,
remove 1.6 ms, field policies 0.8–1.2 ms. These are fixture measurements, not
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
