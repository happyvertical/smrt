# Run-time models (#4871)

`src/runtime-model.ts`, exported from the root entry. An app defines a smrt
model from data (no class source, no rebuild) and gets the storage, REST, MCP
and method surfaces of a decorated class.

| API | Purpose |
|---|---|
| `runtimeModelEntry(def)` | Definition to manifest entry: fields, columns, `conflictColumns: ['id']`, method exposure |
| `registerRuntimeModel(def, { methods })` | Register the entry; set method functions on the prototype; returns the qualified name |
| `planRuntimeModelDDL(name, engine, existingColumns)` | Additive statements: `CREATE TABLE` plus indexes when the table is missing, else `ADD COLUMN` (nullable) per missing column |

## Rules

- **Conflict key.** A standalone model upserts on `id`. The default (slug,
  context) key has no unique index behind it on these tables: untitled records
  would fail to save and records sharing a title would merge. A subclass
  (`extends`) declares no key unless asked: an explicit key on an STI subclass
  owns an extra partial unique index (#3456), and an empty subclass must change
  nothing.
- **Methods.** An entry's `methods` carry `decoratorConfig: {}` and the class's
  `mcp.include` lists them, so SMRT generates `<model>_<method>`. The generated
  tool passes declared parameters positionally; `registerRuntimeModel` wraps
  each function so it receives one object of those parameters (`this` is the
  record).
- **The registry only adds.** Re-registering never removes a field and keeps
  the first exposure config. A host that edits models builds a fresh registry
  (worker or process) per definition.
- **Sync columns.** Entry columns include `_sync_origin_device_id` and
  `_sync_revision`; deletes read them.
- **Tables are not created for you.** Run `planRuntimeModelDDL` output in the
  host's own transaction, with `existingColumns` read through that transaction.
  (The SQLite adapter creates tables of registered decorated classes in
  in-memory test databases; do not rely on it.)

## Run-time subclasses of a registered class (`extends`)

`extends: '@pkg:Class'` registers a class that extends the real constructor
(inherited fields, methods and `_meta_type` lookup work) and may share the
parent's simple name (`@local/app:Profile` extends
`@happyvertical/smrt-profiles:Profile`) without the STI child-wins rule
replacing the parent. `findClass('Profile')` is then ambiguous: use qualified
names.

Answers to the open checks of #4869, each with a test in
`src/__tests__/runtime-model.test.ts`:

1. **One-table-per-class parent.** The subclass gets its own table (its name's
   plural, or `tableName`) holding the base columns and the subclass's fields.
   Inherited fields are not stored in a subclass's table by smrt itself
   (decorated subclasses behave the same), so `runtimeModelEntry` declares the
   parent's fields again on the subclass. The parent's table and collection do
   not see the subclass's records. An empty subclass of such a parent is **not
   free**: it adds a table.
2. **Package schema migrations.** Subclass columns on an STI parent's table are
   tolerated: comparing the database to the parent's own schema reports them as
   advisory `orphan_column`s with no SQL, and drops them only with
   `includeDroppedColumns` / `--drop-columns`.
3. **Empty subclass of an STI parent is free.** The merged table schema is
   byte-identical before and after registering it, the plan against the
   existing table is empty, and no table, index or row changes.

For an STI parent, the subclass's fields become nullable columns on the parent's
table, its records carry its own `_meta_type`, and the parent's collection
returns them (as subclass instances).

## Reference and presentation definitions (A4 prerequisites)

`RuntimeFieldType` also accepts `foreignKey` and `crossPackageRef`. Supply
`related` as a qualified model identity. Use `foreignKey` within the app and
`crossPackageRef` across package boundaries, as for decorated models. A physical
FK target must already be registered; its registry table binding, including an
explicit `tableName`, is used rather than deriving a table from the qualified
name. Cross-package references retain relationship metadata without a DDL FK.

`RuntimeFieldDefinition.ui` uses the existing `FieldUIHints` contract, stored
at `_meta.ui`. Invalid widget/type and format/type combinations fail before
registration. `RuntimeModelDefinition.ui` carries model label/icon/description;
`display.label` selects an own scalar field and rejects missing/reference fields.
`runtimeModelEntry()` resolves `displayLabelField` and defaults it by the normal
`name`, `title`, `label`, `code` rule. These are manifest inputs; publishing an
entry does not rewrite an already-generated web module or mounted route.

| Person's field | Existing runtime definition |
| --- | --- |
| Text / long text | `text` / `text` with `ui.widget: 'textarea'` |
| Whole number / decimal | `integer` / `decimal` |
| Money and currency | `integer` with `ui.format: 'money'`, plus a `text` currency-code field with `ui.widget: 'currency'` |
| Date / date-time | `datetime` with `ui.format: 'date'` / `'datetime'` |
| Yes/no / single choice | `boolean` / `text` with `enum` |
| Reference | `foreignKey` or `crossPackageRef` with `related` |

For schema application, register the definitions, then call the existing
`migrateSmrtSchemas({ db, packageName, ... })` from `smrt-core/migrations`.
Inspect `hasManualDrift` and refuse activation if it is true. Do not execute
`planRuntimeModelDDL()` statements directly as an app-editing shortcut. The
migration differ/tracker owns transactions, ordering and migration records.
The SQLite test uses this path, checks its tracking row and a no-op second
migration, and exercises the generated REST handler without a listening server.

### A4 application lifecycle is not implemented

This API remains a trusted, low-level model-definition API. It is **not** the
versioned editor for a person's fields/lists. In particular:

- Runtime subclasses deliberately coexist with their parent; they do not take
  the same-name app replacement path used by generated consumer manifests. A
  default-named CTI parent and same-name runtime child can collide on their
  physical table. A distinct table would not implement A4's app override.
- Re-registration merges fields and retains the first exposure configuration.
  It cannot implement rename/hide/remove/undo by overwriting a definition, and
  a fresh registry in the serving process would invalidate unrelated users.
- Runtime REST/MCP generators can read registered metadata. AOT SvelteKit
  routes, web definitions, static CLI/tool definitions and the cookbook's
  exposure catalog are separate generated artifacts. Registration does not
  atomically refresh them or admit a new custom list through the live gate.
- Cookbook v1's `policies` customize existing fields; `features` enable known
  catalog models. Neither represents model definitions or source revisions.
  Unknown-key preservation is not an authored customization contract. No new
  cookbook field or parallel export format is introduced here.

A complete editor needs one agreed portable cookbook/app-definition slot and a
host activation protocol: persist a pending revision, generate the normal app
subclass/model sources, regenerate all surfaces, migrate through the tracker,
start an isolated candidate runtime, and only then publish its catalog and
route the app to it. Failures must leave the old version serving and the pending
revision recoverable. Removal should retain columns/data, with undo reactivating
the prior definition; purge needs a separate explicit migration contract.
That host protocol is not supplied by core's registry APIs. No end-to-end
apply/reload latency, durable change log, restart recovery, tenant-safe editor,
export/import or undo is claimed by these prerequisites.

### Test design

All executable cases here use in-process SQLite. No new persistence executor,
authentication path or schema mutation API is introduced. PostgreSQL/DuckDB
execution, production reloads and tenant-editor authorization are unverified.

| Behavior / trigger | Positive case | Failure case | Context / executor | Edge / level | Validation |
| --- | --- | --- | --- | --- | --- |
| Define presentation | Runtime entry, registry and web field projection retain hints/display | Invalid widget/format/type and missing/reference display fields fail before registry mutation | Trusted app definition; no SQL | Manifest/public metadata; unit | core test |
| Input ownership | Later caller edits do not mutate enum/model/field UI snapshots | Original values remain intact | Trusted app definition; no SQL | Definition boundary; unit | core test |
| References | Scalar REST round trips, cross-package load, subclass reference back to app list; custom physical FK table | Missing/unqualified targets rejected | Fixture provider/app identities, one SQLite handle | REST, ORM, MCP/provider schema; integration | core test |
| Migration ownership | Tracker records schema creation; repeated migration is empty | Manual drift must be refused by host (no host editor provided) | Same SQLite handle, normal migration tracker transaction | DDL/tracker; integration | core test |

Executable coverage: `src/__tests__/runtime-model-presentation.test.ts` plus the
existing `runtime-model.test.ts`. No existing test is weakened. The A4 lifecycle
items above remain explicit design/implementation gaps, not passing test rows.
