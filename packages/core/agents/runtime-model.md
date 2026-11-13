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
   plural, or `tableName`) holding the base columns, the parent's fields
   (concrete ancestors' too, nearest declaration winning) and the subclass's
   own (#4922). `runtimeModelEntry` lists the inherited fields on the entry,
   relaxed to optional, except a field smrt needs (it keeps `required` and its
   `requiredFor`, #4932); a definition that restates one still yields one
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

## Run-time models and the data shape rules (#4920)

The rules are in [data-shape-rules.md](data-shape-rules.md). A run-time
definition is shape that the app registers, so it counts under rule 2 like a
decorated class. What differs from a decorated class:

- **Migrate never sees it.** `db:migrate` plans from classes in the build. The
  host applies the `planRuntimeModelDDL` statements itself, so rules 4 to 7
  (apply when safe, stop to avoid losing data, all or nothing) do not cover
  these tables. The host decides when to apply them.
- **A required field may be enforced only in code.** A new table gets `NOT NULL`
  for a required field. A column added to an existing table is always nullable.
  The save-time check still refuses a record without the value.
- **The one refusal still applies.** An app may not loosen a field smrt needs
  (rule 3). `runtimeModelEntry` and `registerRuntimeModel` throw
  `CONFIG_REQUIRED_FIELD_LOOSENED`, naming the class and field, when a
  definition that extends a registered class restates a required field that
  carries `requiredFor` (a required tenant field included) as optional. Only a
  definition that states `required: false` loosens: a redeclared field inherits
  every option it leaves out (`required`, `requiredFor`, `enum`, `default`, ...),
  by the same rule as a built subclass, type-change rule included. It is
  the same decision the build uses (`schema/field-inheritance.ts`). Tightening,
  or loosening a field with no reason, registers as before.
