# smrt-preferences

User-interface preferences (#3727): one `_smrt_ui_preferences` system table
for tenant defaults and per-user preferences of any registered **kind**, the
kind registry, the generic store, and two built-in kinds: `overview`
(customizable overview pages of `@happyvertical/smrt-svelte/overview`, with an
overview-shaped layer on top) and `shell-layout` (the AdminShell
`ShellSettingsDelta`). The kind contract is in
[agents/preference-kinds.md](agents/preference-kinds.md); the overview
surface itself is in
[smrt-svelte overview-surfaces.md](../smrt-svelte/agents/overview-surfaces.md).

## Why a package of its own

The repo puts each layered-override table in the package that owns its
resolution (`smrt-prompts`, `smrt-playbooks`, `smrt-features`,
`smrt-fields`). `smrt-svelte` has no runtime dependency on core, tenancy or
users and holds no tables. This package imports only smrt-svelte's
Svelte-free entries (`./overview/server`, `./workspace/server`).

## Pieces

| File | Contents |
| --- | --- |
| `src/models/UiPreferenceRecord.ts` | The row; owns identity, scope shape and authorization; refuses unregistered kinds |
| `src/collections/UiPreferenceRecordCollection.ts` | Undecorated reads (`findTier`); internal, not exported; no generated surface |
| `src/write-capability.ts` | The store-only write capability (internal) |
| `src/read-guard.ts` | The owner-read interceptor (internal) |
| `src/kinds.ts` | `registerPreferenceKind`, `requirePreferenceKind`, `UnknownPreferenceKindError`, the validation contract |
| `src/store.ts` | `createPreferenceStore({ db })`: generic `load` / `save` / `reset(kind, surfaceId, ...)` |
| `src/kinds/overview.ts`, `src/overview.ts` | The `overview` kind and `createOverviewStore` (`load`, `save`, `reset`, `loadPage`, `loadWidget`, `withTenantDefaults`) |
| `src/kinds/shell-layout.ts` | The `shell-layout` kind and `createShellSettingsPreferences` (the server half of a `ShellSettingsAdapter`) |
| `src/kinds/builtin.ts` | Registers the two built-in kinds (imported by the entry and the store) |
| `src/context.ts` | The ambient principal and `PreferenceAccessError` |
| `src/permissions.ts` | `overviews.customize` / `overviews.personalize`, `shell.customize` / `shell.personalize` |

## Table

`_smrt_ui_preferences`: `tenant_id` (UUID), `kind`, `surface_id`,
`scope_type` (`tenant` | `user`), `user_id` (UUID, NULL on tenant rows),
`scope_key` (`__tenant__` or the user id), `payload_json` (the kind's
canonical payload), `format_version`, `updated_by`, plus the SmrtObject
columns. Unique key `(tenant_id, kind, surface_id, scope_type, scope_key)`;
every key column is NOT NULL, so the index is total on every engine. It ships
through manifest-driven migrations (`smrt db:migrate`), never runtime DDL;
`src/__tests__/migration.test.ts` applies it with `migrateSmrtSchemas` on
SQLite and DuckDB and asserts parity afterwards. On DuckDB only this table is
migrated in tests: smrt-users' tables carry ON UPDATE CASCADE foreign keys
DuckDB cannot create.

## Invariants

- **Kinds gate everything.** The store and the model refuse a kind that is
  not registered (`UnknownPreferenceKindError`), so no row exists that no code
  can validate. A kind's `validate` runs strictly on save (refuse unless `ok`,
  store only `canonical`, `null` deletes the row) and leniently on load (use
  `canonical`, report `issues`, never rewrite the row). A row written at a
  newer `format_version` than the kind's is dropped and reported.
- **Store-only writes.** Only the store writes rows: it passes a
  module-private symbol capability (`src/write-capability.ts`, not exported;
  the smrt-approvals pattern) bound to the exact `payloadJson` the kind
  validated, single-use, and grants each delete the same way. The model
  refuses any insert, update (also in `validateBeforeSave`, so bulk creates
  are covered) or delete without it, so `new UiPreferenceRecord(...).save()`,
  a collection `create()` or `row.setPayload(); row.save()` never store an
  unvalidated payload. Tests seed corrupt storage with raw SQL
  (`src/__tests__/raw-rows.ts`). This guards in-process callers, not raw SQL.
- **Owner-safe reads.** A principal never reads another user's row. An
  interceptor (`src/read-guard.ts`, registered when the model loads and
  again before every store read) drops other users' user-scope rows from
  every collection `list` / `get` / `query`, after tenancy has confined the
  read to the tenant; tenant rows stay visible to the whole tenant, and a
  row whose scope it cannot tell (a narrow `select`) is dropped. Single-row
  hydration (`new UiPreferenceRecord({ id }).initialize()`) is checked in the
  model (`loadFromId` / `loadFromSlug`). A principal without a user id sees
  no user rows.
- **Not an app API.** `UiPreferenceRecord` stays a root export only because
  generated consumer registration imports every public manifest object from
  the root; the collection is not exported. Apps use `createPreferenceStore`,
  `createOverviewStore` and `createShellSettingsPreferences`.
- **Tiers.** The tenant row is the default; the user row applies on top, and
  `validate` for the user tier receives the tenant tier's canonical payload
  (`ctx.tenant`). User rows are per tenant: preferences name tenant data.
- **Identity is ambient.** No API takes a tenant or user id. A missing
  principal throws `PreferenceAccessError`; a principal without a user id has
  no user tier and cannot write one. A session-only principal (users
  `createSessionHandler()` without `enterTenantContext`) is entered as a
  tenant context with the same identity before any table access.
- **Tenancy.** The model is `@TenantScoped({ mode: 'required' })`, and every
  store read also names the tenant explicitly (a super-admin bypass context
  does not filter reads). `save()`/`delete()` refuse a row whose stored
  tenant, kind, surface or tier differs from memory (matched by predicate:
  DuckDB returns raw UUID columns as lossy HUGEINTs), a foreign tenant, and a
  user row that is not the principal's.
- **Permissions are per kind.** Each kind names `{ tenant, user }` slugs;
  the model asserts them (`assertOperationPermission`, fail closed) and the
  store reports them as `canCustomize` (`checkOperationPermission`). A slug
  must be in the users catalog or it never grants. The users resolver denies
  a principal with no user id even with the slug in its set. The built-in
  `personalize` slugs are in users' self-personalization list (seeded for
  owner/admin/member/viewer once registered).
- **Permission source.** The principal's permission set is authoritative,
  including an explicit empty set: a tenancy adapter without
  `resolvePermissions` refuses everyone (fails closed). Hosts must configure
  it, or enter identity through users' `enterTenantContext`; never widen it
  here.
- **Concurrency.** Optimistic: a save passes the `revision` (ISO
  `updated_at`) it loaded, `null` meaning "no row". Updates use core's
  revision CAS (`save({ expectedUpdatedAt })`), a first write is a strict
  insert (`_insertOnly`) so a racing first write hits the unique index, and
  a delete is guarded the same way. `reset` treats `revision: null` like
  save does (a row that exists now conflicts); only an omitted revision
  resets unguarded. Mismatch: `{ ok: false, reason: 'conflict' }`. Exception, documented: `createShellSettingsPreferences().write`
  without a revision reads the current one first, i.e. last-writer-wins,
  because the shell's `ShellSettingsAdapter.write(delta)` carries none.
- **Overview `loadWidget`** lets a principal without either customize
  permission load only a widget on their resolved overview; anything else is
  `not_allowed`. The widget is sanitized against the page definition first.
- **No generated surface** (`api: { include: [] }`, `cli: false`,
  `mcp: { include: [] }`): a generated route would skip kind validation.

## Tests

`pnpm test` runs the overview suite and the kinds suite on SQLite and DuckDB
plus the migration suite; `pnpm test:postgres` runs both suites on PostgreSQL
(`*.optional.test.ts`, skipped without a database).
