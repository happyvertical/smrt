# smrt-svelte/screens

Module semantics for `src/components/screens/` (`./screens`). Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Manifest-derived record screens (`./screens`, #3718)

`RecipeScreens` is the default screen set for a package that ships models but no
consumer UI (tags, facts, secrets, profiles, reports, prompts). It composes
`ListScreen`, `DetailScreen` and `EditForm`, each of which can also be used on
its own. Every screen takes a generated web `definition`
(`ScreenCollectionDefinition`, structurally a `SmrtWebCollectionDefinition`) and
an optional resolved `policy` (`ScreenPolicy`, structurally smrt-fields'
`ResolvedObjectFieldPolicy`). The module imports neither package: smrt-svelte
stays below the domain layer, and the app passes both in as props.

- **Field selection is `fields.ts`, pure and node-testable.** `deriveScreenFields`
  is the single rule for list / view / edit. A field renders only when it is in
  BOTH the definition and the policy, so sensitive, transient and
  read-permission-gated fields (which the policy resolver omits) can never appear
  on a generated screen. Hidden fields are dropped; system fields (`id`,
  `tenantId`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`) are never
  editable, and the two timestamps appear on a view as read-only advanced meta.
  Do not add a second selection rule in a component.
- **Without a policy the code seed applies**: `ui.basic` / `ui.group` / `ui.order`
  hints and the cold-start rule (no `basic` markers => everything basic; any
  marker => unmarked fields advanced). Order is `order`, then declaration order.
- **Tiers**: list shows basic scalar columns only (no long text, JSON or raw
  reference columns; capped at `DEFAULT_MAX_LIST_COLUMNS`, an explicit `columns`
  list is never capped); view and edit show advanced fields behind a disclosure
  (the edit one opens itself when an advanced field has a problem). Policy
  `label`, `help` and `required` win over the manifest; on create, a resolved
  policy default (an explicit `null` included) beats the manifest default.
  `locked` governs who may change the POLICY, never the record value, so it is
  not applied here.
- **Values are `values.ts`**: money (`ui.widget: 'currency'` on an INTEGER field
  only) is integer minor units end to end. Editing shows major units but converts
  with exact string math (`majorStringToMinorUnits`), never `* 100`; integers are
  rejected unless JavaScript-safe; datetimes go out as ISO strings (an unchanged datetime keeps the
  loaded record's full precision via `parseDraft`'s `record` context; the control
  only shows minutes); JSON as parsed values. Empty optional text becomes `null` when the field is nullable and `''`
  otherwise (unset text persists as `''`); every other empty optional field is
  `null`. Errors are codes, mapped to messages by the component via `useI18n`.
- **Transport-neutral.** `RecipeScreens` drives a `RecipeScreensSource`
  (`list` / `get` / `create` / `update` / `delete`); an operation the source lacks
  (or `can` turns off) is simply not offered, so a read-only source is a
  read-only screen set. `view` and `recordId` are bindable and `onnavigate`
  fires on every user navigation, so an app can mirror them into its router.
  `EditForm.onsubmit` throws to report a failed save or returns `{ fieldErrors }`.
  Remount `EditForm` with `{#key}` when switching records (`RecipeScreens` does).
- **Not the policy-editing surface.** The policy gear, field-usage telemetry and
  the per-field renderer registry live in `ObjectForm`
  (`@happyvertical/smrt-fields/svelte`); `EditForm` is the dependency-light
  default and does not replace it. Not wired into recipe surfaces yet (#3708).
- Component props live in `types.ts`, not in the `.svelte` files, so the barrel
  never re-exports types from a component.
- **Where a package model's definition and data come from (#3749).** A cookbook
  app's `smrt()` preset hosts the cookbook's package models; the definition is
  `collectionDefinitions[<collection>]` from `@smrt/web` and the source is the
  model's `/api/<collection>` route (see [cookbook-shell.md](cookbook-shell.md)).
  A model the API does not expose has neither, so the entry page shows its notice.
