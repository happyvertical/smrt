# Preference kinds

The contract between `_smrt_ui_preferences` and the code that owns a
preference's meaning (#3727). Package rules are in [../AGENTS.md](../AGENTS.md).

## Registering a kind

```ts
registerPreferenceKind({
  kind: 'board-columns',            // /^[a-z][a-z0-9-]{0,47}$/
  formatVersion: 1,                 // positive integer, stored per row
  permissions: { tenant: 'boards.customize', user: 'boards.personalize' },
  validate(payload, ctx) {          // never throws
    return { ok, canonical, issues };
  },
}, { replace? }) // -> dispose()
```

Registration is code at module scope, process-wide (one registry per
process). Registering a kind twice throws unless `{ replace: true }`. Both
slugs must be `collection.action` and registered in the users catalog
(`registerPermissionDefinitions`), or they never grant; add a `personalize`
slug to users' built-in self-personalization list only when every built-in
role should hold it.

The store authorizes against the principal's permission set from the
ambient context and never widens it. A tenancy adapter (SvelteKit, Express)
without `resolvePermissions` supplies an explicit empty set, which the store
treats as authoritative: every write is `not_allowed` and `canCustomize` is
false for everyone, owners included. Configure `resolvePermissions`, or let
users' `createSessionHandler({ enterTenantContext: true })` enter the context.

## `validate(payload, ctx)`

| `ctx` field | Meaning |
| --- | --- |
| `kind`, `surfaceId` | What is being validated (`surfaceId` matches `PREFERENCE_SURFACE_PATTERN`) |
| `scope` | `tenant` or `user` |
| `phase` | `save` (strict) or `load` (lenient) |
| `formatVersion` | The version the payload was written at (the kind's own on save); migrate older payloads here |
| `tenant` | User tier only: the tenant tier's canonical payload, or `null` |
| `options` | Host-supplied, kind-specific inputs, passed through from `load` / `save` |

Return `canonical`: the payload with every invalid part removed (`null` means
no preference), `issues`: what was removed and why (`{ path, code, message,
detail? }`), and `ok`: false whenever anything was removed or refused.

- On **save** the store refuses unless `ok`, stores only `canonical` (as
  JSON with the kind's `formatVersion`), and deletes the row when `canonical`
  is `null`.
- On **load** the store uses `canonical` and reports `issues` per tier; the
  row is not rewritten. Unparseable JSON and rows from a newer
  `formatVersion` are dropped before `validate` runs. A `validate` that
  throws on load drops the tier with a `validator_error` issue; on save the
  error propagates and nothing is stored. Validators should not throw.
- A payload is data, never code: no query strings, URLs or expressions a
  reader would execute. Authorization happens where the data is read, never
  through payload values.

## Built-in kinds

| Kind | Payload | Validator | Permissions | `options` |
| --- | --- | --- | --- | --- |
| `overview` | `OverviewOverride` (sparse, version 1) | save: `checkOverviewOverride`; load: `resolveOverview` + `diffOverview`, against the page definition (user tier: tenant-merged via `withTenantDefaults`) | `overviews.customize` / `overviews.personalize` | `{ definition, registry }`; `definition.id` must equal the surface id |
| `shell-layout` | `ShellSettingsDelta` | `sanitizeShellSettingsDelta` from `@happyvertical/smrt-svelte/workspace/server` | `shell.customize` / `shell.personalize` | none |

## Store calls

`createPreferenceStore({ db })` returns `load(kind, surfaceId, { options })`
(both tiers, `canCustomize` from the kind's pair), `save(kind, surfaceId, {
scope, payload, revision, options })` and `reset(kind, surfaceId, { scope,
revision? })` (`null` conflicts when a row exists; omitted is unguarded). Failures are `{ ok: false, reason: 'not_allowed' | 'conflict'
| 'invalid' }`; an unregistered kind throws `UnknownPreferenceKindError`.

Kind-shaped layers sit on top: `createOverviewStore` (the overview page API)
and `createShellSettingsPreferences` (the server half of the shell's
`ShellSettingsAdapter`: `read(surfaceId)` merges tenant and user with
`mergeShellSettingsDelta`; `write(surfaceId, delta, { scope?, revision? })`
is last-writer-wins only when the revision is omitted).
