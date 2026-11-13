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
- **Defaults.** Synthesized runtime constructors copy declared field defaults
  per instance, preserving parent property initializers and explicit options.
  They read current registry metadata so additive refresh defaults apply too.
- **Additive refresh.** Default registration keeps the first exposure config.
  Explicit `refresh: true` refreshes runtime metadata and validators; it never
  drops storage. The [app model editor](app-models.md) owns versioned edits.
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
   plural, or `tableName`) holding the base columns, the parent's fields
   (concrete ancestors' too, nearest declaration winning) and the subclass's
   own (#4922). `runtimeModelEntry` lists the inherited fields on the entry,
   relaxed to optional; a definition that restates one still yields one
   column, its own declaration winning. The parent's table and collection do
   not see the subclass's records. An empty subclass of such a parent is **not
   free**: it adds a table, which holds the inherited columns.
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

## Same-name replacement and versioned editing

Explicit `replaces: true` requires a registered same-name `extends` target.
It follows the existing app replacement lineage, preserves the provider's real
constructor/methods, tenancy and table (including CTI), and publishes the app's
qualified identity as effective. Old provider identities resolve to it.
Omitting `replaces` retains the coexistence behavior described above. Inherited
fields resolve through the shared `schema/field-inheritance.ts` rule, including
unmerged provider ancestry. Replacements keep inherited requiredness and UI
metadata; only independent own-table subclasses rebind framework tree links.

`registerRuntimeModel(def, { refresh: true, fieldValidators })` refreshes
metadata for an existing runtime definition. Custom validators use the record's
database executor; reference checks therefore retain transaction and tenant
context. Registry generation invalidates collection field caches and live
REST/MCP/CLI definitions.

Use [`createAppModelEditor()`](app-models.md), exported from `./app-models`,
for the person's versioned fields/lists. It supplies the cookbook source,
tracked migrations, host-owned history, pending recovery, policy operations,
manifest/web projections and publication readiness gate. Low-level registry
registration alone still does not rewrite static route files or web modules.

Executable coverage: `src/__tests__/runtime-model.test.ts`,
`runtime-model-presentation.test.ts`, `same-name-app-subclass.test.ts`,
and `app-model-editor.test.ts`. All use in-process SQLite; PostgreSQL/DuckDB
editor activation and packaged desktop behavior are unverified.
