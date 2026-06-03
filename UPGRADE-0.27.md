# Upgrading to SMRT 0.27.0 (relationships-v2)

0.27.0 is the **relationships-v2** breaking release. It consolidates how SMRT
declares and resolves relationships across every `@happyvertical/smrt-*`
package. The code changes are mostly transparent at the API level, but **two of
them require a manual DATA migration** on existing databases:

1. several columns are **renamed** (R3), and
2. `id` / foreign-key columns become **native `uuid`** on PostgreSQL (R11).

The structural migration (`smrt db:migrate`) is **additive** — it adds new
columns and indexes but cannot rename a column or change a column's type in
place. So on an existing database it will add the new (empty) columns and leave
the old ones orphaned. **Without the data migration in this guide you will lose
data** (the new column stays empty; the old column is dropped or ignored).

If you are starting a fresh database, none of the data-migration steps apply —
just build, run `smrt db:migrate`, and regenerate your downstream docs.

> Validated consumers (anytown.ai, ergot.io) ran the data migration below
> successfully against real production data. The runnable helper
> (`smrt db:migrate-uuid`) is extracted from their migration scripts.

---

## 1. Breaking changes at a glance

| Area | Change | Action needed |
|------|--------|---------------|
| **R1** | Domain models now declare FKs with `@foreignKey()` (same-package) / `@crossPackageRef()` (cross-package) instead of plain string ids. | None at the call-site; affects schema (see R11). |
| **R3 renames** | `Tag.parentSlug → parentId`; `Fact.parentId → previousFactId`; `Asset.parentId → sourceAssetId`; Folder split out of the `assets` table into its own `folders` table. | **Data migration** — backfill renamed columns (§3.1). |
| **R4** | `AssetAssociation` (and any generic/provenance link) now extends the new `SmrtPolymorphicAssociation` base — a `(metaType, metaId)` + `role` polymorphic link. | None unless you subclassed the old shape; rebuild. |
| **R5-canon** | STI discriminator `_meta_type` is now the **qualified** name (`@happyvertical/smrt-content:Article`), and registry/STI lookups return qualified names. | **Data migration** — upgrade legacy bare `_meta_type` values (handled by `smrt db:migrate --repair-data`). |
| **R8** | `loadRelated()` / `loadRelatedMany()` enforce **tenant isolation** — resolving from a tenant-scoped object into a different non-null tenant throws `TenantIsolationError`. Pass `{ allowCrossTenant: true }` for deliberate cross-tenant flows. | Audit deliberate cross-tenant relationship loads. |
| **R10** | `@oneToMany` relationships generate **child accessor** methods. | None; additive. |
| **R11** | `id` and declared-FK (`@foreignKey` / `@crossPackageRef`) columns are **native `uuid`** on PostgreSQL / DuckDB (`TEXT` on SQLite). | **Data migration** — convert TEXT id/FK columns to `uuid` (§3.2). |
| **SmrtJunction** | The base junction API is `byLeft()` / `byRight()` (was `getForX()`), and `attach()` / `detach()` take **positional** `(leftId, rightId, opts)` with an **options object** for extra fields (was positional extras). | Update call-sites (§2). |

### Empty-string FK default → NULL (framework fix, no action)

A declared FK left at its TypeScript default `''` (e.g. a root entity whose
optional self-reference is never set — `Fact.previousFactId` on a root fact)
used to fail to insert on PostgreSQL with `invalid input syntax for type uuid`.
0.27.0 coerces `''` → `NULL` for uuid columns in the ORM save path, so this
works transparently. No consumer change required.

---

## 2. Code-level API changes

### SmrtJunction: `getForX` → `byLeft` / `byRight`, options-object attach/detach

```ts
// Before
const rows = await links.getForContent(contentId);
await links.attach(contentId, assetId, 'thumbnail', 0); // positional extras

// After
const rows = await links.byLeft(contentId);            // or byRight(assetId)
await links.attach(contentId, assetId, {               // options object
  relationship: 'thumbnail',
  sortOrder: 0,
});
await links.detach(contentId, assetId, { relationship: 'thumbnail' });
```

`byLeft(leftId, opts?)` / `byRight(rightId, opts?)` return junction rows ordered
by the subclass's `sortField` (default `sortOrder`). `opts` is an additional
WHERE filter. See `packages/core/src/junction.ts`.

### loadRelated tenant guard (R8)

```ts
// Throws TenantIsolationError if `related` lives in a different non-null tenant:
const related = await obj.loadRelated('ownerId');

// Opt out for admin / cross-tenant tooling:
const related = await obj.loadRelated('ownerId', { allowCrossTenant: true });
```

---

## 3. Data migration (existing databases)

Run these **after** `smrt db:migrate` has added the new columns. All steps are
**idempotent** — safe to re-run. Always do a `--dry-run` first and take a
backup.

```bash
# 0. Apply the additive structural migration first.
smrt db:migrate

# (also upgrades legacy bare _meta_type discriminators to qualified form)
smrt db:migrate --repair-data
```

### 3.1 Backfill the R3 column renames

Each rename added a new empty column and left the old one in place. Copy the
data across and drop the old column. Only run the renames for the models your
project actually uses.

| Model | Old column | New column |
|-------|-----------|-----------|
| Tag | `parent_slug` | `parent_id` |
| Fact | `parent_id` | `previous_fact_id` |
| Asset | `parent_id` | `source_asset_id` |

Using the bundled helper (`smrt db:migrate-uuid`, see §3.3), scoped to each
table:

```bash
# Dry-run everything first.
smrt db:migrate-uuid --skip-convert --dry-run \
  --rename "tags.parent_slug:parent_id,facts.parent_id:previous_fact_id,assets.parent_id:source_asset_id"

# Apply.
smrt db:migrate-uuid --skip-convert \
  --rename "tags.parent_slug:parent_id,facts.parent_id:previous_fact_id,assets.parent_id:source_asset_id"
```

> **Tag note:** the old `parent_slug` held a *slug*, while the new `parent_id`
> holds the parent's `id`. A straight column copy is only correct if your
> existing `parent_slug` values already store ids. If they store genuine slugs,
> resolve slug → id first (a short project script joining `tags` to itself on
> `slug`), then drop `parent_slug`. The bundled helper does a verbatim copy; use
> it only when the source already holds ids.

> **Folder split (R3-D):** Folder rows moved from the shared `assets` table
> (`type_slug='folder'`) to a dedicated `folders` table. If you have Folder data
> in `assets`, migrate those rows into `folders` with a project script before
> dropping the old discriminator rows — this split is data-shaped per project
> and is not auto-handled.

### 3.2 Convert TEXT id/FK columns to native `uuid` (PostgreSQL)

On PostgreSQL, `id` and declared-FK columns should be promoted from `TEXT` to
native `uuid`. The bundled helper is **self-classifying**: it converts a column
only when **every** non-empty value is a canonical UUID, and **skips** any
column with a genuine non-uuid value (slugs, external ids like
`'google-weather'`, legacy unhyphenated ids, analytics measurement ids, …),
leaving those as `TEXT`.

```bash
# See exactly what would convert / be skipped — no changes.
smrt db:migrate-uuid --dry-run

# Apply (renames + conversion in one go if you also pass --rename).
smrt db:migrate-uuid
```

SQLite stores SMRT uuid columns as `TEXT` and DuckDB accepts uuid strings
transparently, so the conversion pass is a no-op there — the helper reports this
and exits cleanly.

### 3.3 The migration helper: `smrt db:migrate-uuid`

`smrt db:migrate-uuid` (in `@happyvertical/smrt-cli`) bundles both steps:

| Flag | Effect |
|------|--------|
| `--rename "old:new[,old2:new2]"` | Backfill renamed columns: copy `old → new` where `new` is still empty (cast to `uuid` if `new` is already a uuid column), then `DROP COLUMN old`. Use `--table <name>` to scope, or `table.old:new` per entry. |
| `--table <name>` | Default table for `--rename` entries that omit one. |
| `--skip-convert` | Run only the renames; skip the TEXT→uuid conversion. |
| `--dry-run` | Print the SQL without executing. |
| `-v, --verbose` | Detailed output. |

Both steps run inside a single transaction and roll back on error.

**If you need behavior the helper doesn't cover** (slug→id resolution, the
Folder split, bespoke skip rules), the self-classifying conversion is a short,
auditable pattern you can adapt. The canonical reference is the validated
consumers' scripts (e.g. anytown's
`apps/dashboard/scripts/{migrate-uuid-columns.ts,backfill-asset-source-id.ts}`):
scan `information_schema.columns` for TEXT `id`/`*_id` columns, count
non-empty-non-uuid values per column, and run
`ALTER COLUMN <c> TYPE uuid USING NULLIF(btrim(<c>), '')::uuid` only for the
columns where that count is zero (dropping any `''` default first).

---

## 4. After upgrading

Regenerate the downstream framework doc so your project's `.claude/` reflects
the 0.27.0 package docs:

```bash
smrt docs:claude
```

This rewrites `.claude/smrt-framework.md` from the installed package
`CLAUDE.md` files with updated version tables.

---

## Migration checklist

- [ ] `pnpm install && npm run build`
- [ ] Update SmrtJunction call-sites (`getForX` → `byLeft`/`byRight`; options-object `attach`/`detach`).
- [ ] Audit deliberate cross-tenant `loadRelated()` calls; add `{ allowCrossTenant: true }` where intended.
- [ ] Back up the database.
- [ ] `smrt db:migrate` (structural) then `smrt db:migrate --repair-data` (`_meta_type`).
- [ ] `smrt db:migrate-uuid --dry-run` (review), then apply the R3 rename backfills (§3.1).
- [ ] `smrt db:migrate-uuid --dry-run` then apply the TEXT→uuid conversion on PostgreSQL (§3.2).
- [ ] Handle project-shaped data (Tag slug→id, Folder split) if applicable.
- [ ] `smrt docs:claude` to regenerate the downstream doc.
