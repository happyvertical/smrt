# Cookbook v1 contract (#3747, #3748)

A cookbook is the portable JSON document that says what an app is made of.
Defined once here so the CLI (`smrt cookbook validate|apply`) and the cookbook
app shell read the same thing.

| Piece | Where |
|---|---|
| Types (type-only) | `@happyvertical/smrt-types`: `Cookbook`, `CookbookPolicyRow`, `CookbookLayout`, `CookbookTheme`, `CookbookOverviewOverride`, `CookbookExposureSurface` |
| Parse / validate / migrate (browser-safe) | `@happyvertical/smrt-core/cookbook`: `validateCookbook(doc, { recipes? })`, `parseCookbookText`, `COOKBOOK_SCHEMA_URL`, `COOKBOOK_LEGACY_SCHEMA_URL`, `COOKBOOK_VERSION` |
| JSON Schema | `@happyvertical/smrt-core/cookbook/v1.schema.json` (`$id` is the `$schema` URL; s-m-r-t.dev hosts it later) |
| Fixtures | `src/cookbook/__fixtures__/` (the planner's bakery, mechanic, welder, yoga-studio documents) |

Fields: `$schema`, `version: 1`, optional `name`/`description`, `recipes`,
`features` (absent reads as `[]`), `policies` (app-scope smrt-fields rows),
`exposure`, `layout` (smrt-svelte `ShellLayout`), `theme`, `overviews`
(smrt-svelte `OverviewOverride` per overview id). Sample data is not part of
the document; the planner's library wrapper (id, icon, keywords, settings) is
planner-side.

## Rules

- Versioning: add optional fields within `version: 1`; readers keep and ignore
  unknown keys (`additionalProperties: true`). A breaking change is `version: 2`.
- Layout and overview values are typed structurally so smrt-types and core never
  depend on smrt-svelte; smrt-svelte owns deep validation (widgets against page
  definitions, nav ids). Keep `CookbookLayout`/`CookbookOverviewOverride`
  assignable from the smrt-svelte types.
- Legacy `.../blueprint/v1.json` is accepted on read and rewritten; never written.
- Recipe existence, `requires`/`requiresAny` and setting targets need manifests:
  `validateCookbook(doc, { recipes })` checks ids when a catalog is passed;
  the rest is the CLI's job.
- Keep the JSON Schema and `validate.ts` in step; the test validates the same
  fixtures against both.
