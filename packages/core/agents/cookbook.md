# Cookbook v1 contract (#3747, #3748)

A cookbook is the portable JSON document that says what an app is made of.
Defined once here so the CLI (`smrt cookbook validate|apply`) and the cookbook
app shell read the same thing.

| Piece | Where |
|---|---|
| Types (type-only) | `@happyvertical/smrt-types`: `Cookbook`, `CookbookPolicyRow`, `CookbookLayout`, `CookbookTheme`, `CookbookOverviewOverride`, `CookbookExposureSurface` |
| Parse / validate / migrate (browser-safe) | `@happyvertical/smrt-core/cookbook`: `validateCookbook(doc, options)`, `parseCookbookText`, `CookbookDiagnostic`, `COOKBOOK_SCHEMA_URL`, `COOKBOOK_LEGACY_SCHEMA_URL`, `COOKBOOK_VERSION` |
| JSON Schema | `@happyvertical/smrt-core/cookbook/v1.schema.json` (`$id` is the `$schema` URL; s-m-r-t.dev hosts it later) |
| App shell | `@happyvertical/smrt-svelte/cookbook` renders a cookbook; `loadCookbookApp` in `/cookbook/server` loads and validates it ([cookbook-shell.md](../../smrt-svelte/agents/cookbook-shell.md)) |
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
  depend on smrt-svelte. Hosts pass manifest-derived `layout` ids,
  `themePresets`, `overviewIds`, and a `validateOverview` callback to the core
  validator for checks that need resolved pages or a widget registry. The
  callback returns canonical plain data; cookbook values are never executed.
  Malformed or host-rejected overview entries are dropped and reported as
  warning diagnostics, while a malformed top-level `overviews` field rejects
  the document. `CookbookLayout`/`CookbookOverviewOverride` are
  identical to the smrt-svelte types; a typechecked assertion in smrt-svelte
  (`cookbook/__tests__/contract-types.ts`) fails when either side adds a field.
- Legacy `.../blueprint/v1.json` is accepted on read and rewritten; never written.
- Recipe existence, `requires`/`requiresAny` and setting targets need manifests:
  `validateCookbook(doc, { recipes })` checks ids when a catalog is passed;
  the rest is the CLI's job.
- Every result includes structured `diagnostics` (`severity`, stable `code`,
  `path`, `message`). The existing `errors` and `warnings` string arrays remain
  for compatibility and are derived from those diagnostics.
- Keep the JSON Schema and `validate.ts` in step; the test validates the same
  fixtures against both.

## Applying a cookbook

`smrt cookbook validate <file|url>` and `smrt cookbook apply <file|url> [dir]`
(`packages/cli/agents/cookbook-apply.md`) are the consumers. Apply writes
`smrt.cookbook.json` at the project root, plus the packages the recipes,
features and policies need, into `package.json`. The file is the cookbook
verbatim (legacy `$schema` rewritten); apps read it, apply does not interpret it.
`policies` is required by the validator (use `[]`). The cookbook carries no package
versions, so apply uses the project's smrt line.

## Hosting package models

An app that applies a cookbook lists the recipes' packages in `consumer.packages`
and nothing else: the `smrt()` Vite preset derives the REST allowlist from the
cookbook, so the Orders of a `commerce.sales` recipe get `/api/orders` routes and
an `@smrt/web` definition (see [build-knowledge.md](build-knowledge.md), "Package
models over REST"). `exposure` listing `api` for a model withdraws its route. Models that share an
STI table (the bakery's `Order`, `WholesaleOrder`, `PurchaseOrder` and
`ProductionOrder`; `Product` and `Material`) each get their own route and
definition, at `/<class collection>` (`/orders`, `/productionorders`), listing
only their own rows; the build-knowledge section explains why.

Permissions do not follow the route. The permission catalog grants one namespace
per STI table, the base's (`contracts.create`; there is no `orders.create`), so a
hosted subclass moved to its own route collection keeps authorizing against the
base's slugs: the hosting rewrite records the original collection as
`permissionCollection`, which the generated route guard and `sync/apply` read
before the (rewritten) route collection. It matches the fail-closed `api`
inheritance and the CLI/MCP operation guards, which already derive the base's
slug. No role is widened: a caller needs exactly the grants the base requires.
Reads need no operation slug. A subclass that declares its own `collection` has
its own namespace and is untouched.

## Editing a cookbook

The command engine (`@happyvertical/smrt-core/cookbook/engine`) is the one place
that changes a cookbook: see [cookbook-engine.md](cookbook-engine.md).
