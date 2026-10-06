# ADR 0003: `smrt add` — declarative package install, mount by default, opt-in eject

- Status: proposed
- Date: 2026-10-06
- Issue: [#3378](https://github.com/happyvertical/smrt/issues/3378) (parent [#3367](https://github.com/happyvertical/smrt/issues/3367))
- Schema: [`0003-smrt-package.schema.json`](0003-smrt-package.schema.json)
- Reference descriptor: [`packages/content/smrt-package.json`](../../packages/content/smrt-package.json) (inert draft)

## Context

Adding a s-m-r-t package to an application should be one command that writes
no application code by default. Two decisions are settled and not reopened
here: **mount by default, opt-in eject**, and **a declarative descriptor that
the CLI interprets, never an install script**.

To fix the descriptor's vocabulary from evidence, `@happyvertical/smrt-content`
was added by hand to a throwaway copy of the `smrt-start` template (s-m-r-t
0.54.3, local profile, owner already set up). It took fourteen steps, six of
which were framework gaps rather than choices; [Appendix B](#appendix-b-hand-add-record)
records each one. In short, a developer had to:

1. add the dependency, then decide pnpm's blocked build scripts;
2. add the package to `consumer.packages`;
3. stop the app and run `smrt app migrate` (15 tables);
4. re-seed role permissions with a hand-written route, because nothing does
   it after owner setup (0 of the package's 217 permission slugs existed);
5. replace the `smrt()` Vite preset with its hand-written expansion, because
   the preset cannot host a dependency's REST routes;
6. write a serializer module that the package's model names by app path but
   does not export;
7. write a page route file with its own auth and permission gate;
8. add a nav entry to the root layout;
9. feed the mounted paths back into the page component, whose links pointed at
   the package's own default paths and 404ed;
10. add the assistant grant in a route file (exporting the list from that file
    broke `pnpm build`).

WebMCP, dock tools, MCP and package config needed nothing, but only because
the package declares none of them or the app exposes nothing yet. Removal
then showed that dropping the package from `consumer.packages` leaves its
models registered (a stale `.smrt/manifest.json` merge), and that neither
`smrt app doctor` nor `smrt doctor` reports any of it.

## Decision

### 1. Descriptor home and schema

Each package that offers more than its models ships **`smrt-package.json` at
its package root**. It is published (`files`), exported as
`./smrt-package.json`, authored by hand, validated against
[the JSON Schema](0003-smrt-package.schema.json), and read by the CLI and the
Vite preset **without executing package code**. Its TypeScript type is
`SmrtPackageDescriptor` in `@happyvertical/smrt-types`
([Appendix D](#appendix-d-typescript-types)).

Why a separate file, tied to what already reads package metadata:

- **The consumer plugin already resolves package files through the exports
  map** (`./manifest.json`); `./smrt-package.json` uses the same mechanism, so
  `smrt add`, the preset and doctor locate it the same way.
- **Not `manifest.json`.** That file is generated from source by the build,
  is loaded by the server runtime at boot, and is documented as
  runtime-focused (`DomainKnowledgeManifest.agentSurface` comment in
  `packages/types/src/knowledge.ts`). Nav labels, presets and grant suggestions
  are authored decisions, and would ride into server registration.
- **Not `package.json#smrt`.** Registry metadata carries the whole
  `package.json` of every version, release automation and pnpm rewrite the file,
  and the repository already uses top-level fields for lint switches
  (`smrtJsdoc`, `smrtRawPrimitives`). A dedicated file also gets editor
  validation through `$schema`.
- **Knowledge artifacts carry it, not restate it.** The package build adds the
  descriptor to `sourceHashes` and projects it into `smrt-knowledge.json` as an
  optional `descriptor` field (additive to schema version 1, like
  `agentSurface`), so `knowledge:check` catches a stale projection and agents
  and doctor read one artifact.

What it can express — each entry references identifiers that already exist,
and plan-time validation fails on any that does not resolve:

| Key | Holds | Resolved against |
| --- | --- | --- |
| `requires` | core semver range; packages every preset needs | installed core; `consumer.packages` |
| `permissions` | non-model permissions with default roles | — (model permissions come from the manifest) |
| `pages` | id, title, default path, component, optional server `load`/`actions`, required `permissions`, the REST `routes` it calls, props, nav | `exports` subpaths and their `.d.ts`; manifest objects; permission slugs |
| `dock` | shell dock tools: component, permissions | `exports` |
| `assistantTools` | suggested tool slugs with a reason, never grants | permission catalog (effect computed, not declared) |
| `webmcp.intents` | declared view intent ids | `agentSurface.intents` in the package knowledge artifact |
| `config` | the `packages.<key>` block it reads, and defaults | — |
| `extensions` | models an app may extend, by strategy (`sti`, `reference`) | manifest objects |
| `presets` / `defaultPreset` | named selections of pages, dock tools, extra routes, packages, suggested tools, config | the ids above |

A page's props are JSON plus a closed set of mount-computed values:
`{"$mount": "routesBase"}`, `{"$mount": "navigation"}` (this package's mounted
pages, as `SmrtRouteNavigationItem[]`) and `{"$mount": "href:<page id>"}`. That
is what step 9 of the hand-add needed, without functions in the descriptor. The
set is closed: the schema validates any object with a `$mount` key, at any
depth, only as one of these three forms, so a misspelling such as
`{"$mount": "routesBsae"}` fails instead of passing as plain JSON. One rule is
semantic: an `href:` target must name a page `id` in the same descriptor (a
page the app excludes resolves to no link), and plan-time validation rejects
any other target.

**A package without `smrt-package.json` is wiring-only:** `smrt add` treats it
as an implicit preset with no pages, routes or tools (dependency,
`consumer.packages`, migrate, permission sync).

The app records what it applied in `smrt.config.ts`, one reviewable file:

```ts
export default defineConfig({
  consumer: {
    packages: ['@happyvertical/smrt-content' /* , ... */], // existing (#3370)
    routes: ['@happyvertical/smrt-content:Content'], // new: REST hosting allowlist
    mount: {
      // new: what the shell mounts from each package
      '@happyvertical/smrt-content': { preset: 'workspace' },
    },
  },
  assistant: { allowedTools: ['notes.read', 'notes.create'] }, // new, fail-closed
});
```

`consumer.routes` is exactly the provider-qualified allowlist
`smrtConsumer({ svelteKit: { objects } })` already requires as an HTTP exposure
boundary; the preset reads it instead of forcing an eject (step 5).
`consumer.mount[pkg]` takes `preset`, optional `paths` overrides by page id,
and optional `exclude` page ids; its keys must be a subset of
`consumer.packages`.

### 2. Routes: one catch-all mount route

Adding a package adds **no route files**. The app has one catch-all route,
`src/routes/[...smrt]/` (three one-line files re-exporting framework mounts,
committed once like `hooks.server.ts`), that renders registered pages:

- `+page.server.ts`: `export const { load, actions } = mountRegisteredPages(runtime)`
  matches the path against the mount table, requires a signed-in principal,
  enforces every permission the page declares, then runs the page's server
  `load`;
- `+page.ts`: `export { loadRegisteredPage as load }` adds the page component
  through a lazy import (a universal `load` may return a component);
- `+page.svelte`: `<RegisteredPage {data} />`.

The Vite preset generates the mount table as virtual modules from
`consumer.mount` and the installed descriptors: a universal table (path, lazy
component importer, resolved props, nav, dock) and a server table (permissions,
lazy `load`/`actions` importers from the package's server subpath).

Checked against SvelteKit 2.70.3 and confirmed by a prototype in the throwaway
starter ([Appendix C](#appendix-c-catch-all-prototype)):

| Concern | Finding |
| --- | --- |
| Precedence | `sort_routes` ranks a rest parameter below every static and required segment, so app routes (`/`, `/settings`, generated `/api/*`) always win; a package page can never shadow app code. |
| SSR | Server-rendered: `/articles/hello` SSR HTML contains the article body, in dev and in the adapter-node build. |
| Layouts | Pages render inside the root layout (`AppShell`). A package cannot add nested layouts; a page that needs one is ejected. |
| Per-route `load` | The server load dispatches to the page's registered loader; a missing record returns that loader's 404. |
| Form actions | SvelteKit resolves `actions[name]` at request time; the route exports the static union of action names and each dispatches to the matched page, returning 404 when that page lacks the action. `default` cannot be used (it cannot coexist with named actions). |
| Code splitting | Lazy importers keep each package UI in its own chunk (catch-all node 1.8 KB). A static import of a package UI barrel in the table put 512 KB into the node, so the generated table must never import one statically. |
| Page options | `ssr`, `csr`, `prerender`, `trailingSlash` are read from module exports once per route. A page whose descriptor sets a non-default `render` option cannot be mounted; the plan requires `--eject page:<id>`. |
| Types | `PageData` is generic under the catch-all; an ejected page gets its own `$types`. |
| Navigation cost | The catch-all has a server load, so each module-page navigation fetches `__data.json`, as any route with `+page.server.ts` does today (see #3061). |

Thin generated route files are not the default: they would put per-package
files under `src/routes` and the generated `.gitignore` block (the hand-add
left empty generated directories behind after removal), and a package upgrade
would need regeneration where a mount table follows the installed descriptor.
They remain the **eject** form: `--eject page:<id>` writes committed,
app-owned `+page.svelte`/`+page.server.ts` files that import the same component
and loader.

### 3. Assistant tools stay explicit

Adding or upgrading a package never grants a tool. The plan lists the preset's
`assistantTools` with each tool's effect (`read`, `write`, `destructive`,
computed from the catalog) and the exact flag to grant it; nothing is written
unless the command names the tool:

```text
smrt add @happyvertical/smrt-content --grant contents.read --apply
```

Grants are written to `assistant.allowedTools` in `smrt.config.ts`, which
`mountAssistantRoutes` reads when its `allowedTools` option is omitted (an
explicit option keeps precedence; neither present means no tools). The
principal's RBAC still caps every call. The hand-add showed why the grant moves
out of the route file: the only place to put it was
`src/routes/api/assistant/[...path]/+server.ts`, and exporting the list from
there fails `pnpm build` (`Invalid export`). The permission catalog held 77
`contents.*` slugs; the granted tool list was exactly the three names listed.

MCP (`mountMcpAppRoute({ models })`) and WebMCP (`effects`) exposure stay app
choices in v1; the plan lists the package's model tools and declared intents
under those headings without changing them.

### 4. Extension scaffolds

`--extend <Model>` writes one app-owned model file and nothing else; it is
allowed only for a model and strategy the descriptor lists under `extensions`.

- **`sti`** (default when listed): a subclass in the app's objects directory,
  persisted in the parent's table under the qualified discriminator
  `@<app>:<Name>`:

  ```ts
  // smrt extend: @happyvertical/smrt-content:Article (sti), from 0.55.0. App-owned.
  import { Article } from '@happyvertical/smrt-content';
  import { smrt } from '@happyvertical/smrt-core';

  @smrt({ tableStrategy: 'sti', api: false, mcp: false, cli: false })
  export class NewsArticle extends Article {
    // Numeric defaults define schema: `= 0` integer, `= 0.0` decimal.
  }
  ```

- **`reference`**: a new model in its own table that points at the package
  model with `@crossPackageRef('<qualified name>')`, never `@foreignKey`
  (which is for references within one package), and copies the target's
  tenancy mode so tenant isolation holds. Many-to-many links are not
  scaffolded in v1; they extend `SmrtJunction` by hand.

Both start with generated REST, MCP and CLI exposure off (exposure is opted
into, like `consumer.routes`). Ids and references follow the dialect rules in
root `AGENTS.md` (native UUID on PostgreSQL/DuckDB, text on SQLite). The plan
shows the file and the table or columns the migration adds. Apply writes the
file before it builds, so the build registers the new model and the following
`smrt app migrate` and permission sync include it (see Apply order under CLI
contract). Generated files carry the header above; later
runs never rewrite them, and doctor reports when the source package has moved
on from the recorded version.

### 5. Removal and drift

`smrt remove <pkg>` reverses wiring and mounts, never data:

- it removes the package's `consumer.mount` entry, its `consumer.routes`
  entries, and every `assistant.allowedTools` slug its models own (narrowing is
  always safe, and an unknown slug makes `mountAssistantRoutes` throw), then
  its `consumer.packages` entry, then the dependency;
- it is **blocked** while app code imports the package (an `--extend` model,
  an ejected part, any other import) or another consumed package `requires` it,
  and names each blocker; `--keep-dependency` removes the wiring and keeps the
  import working;
- it never drops tables, columns or rows; the plan lists the tables it leaves
  and, when the database is reachable, their row counts. Role grants stay
  unless `--prune-grants` is passed (a later add restores the same state).

It depends on fixing the stale manifest: today both `saveAggregatedManifest`
(consumer plugin) and `writeLocalManifest` (producer) merge
`{ ...existing.objects, ...new }`, so a package removed from
`consumer.packages` stays registered in `.smrt/manifest.json` (observed:
"preserved 128 consumed package objects" after removal; its tools, pages and
REST still answered) until `.smrt` is deleted. The merge must drop entries whose
package is neither the app nor declared.

`smrt doctor --packages` (and the matching `smrt app doctor` findings)
compares package dependencies, `smrt.config.ts`, installed descriptors, the
`.smrt` artifacts and, when reachable, the database:

| Code | Severity | Condition |
| --- | --- | --- |
| `package-not-installed` | error | in `consumer.packages` but not resolvable |
| `manifest-stale-package` | error | `.smrt/manifest.json` has objects of a package not in `consumer.packages` |
| `mount-unknown-page` | error | `consumer.mount` names a page or preset the installed descriptor lacks |
| `page-missing-route` | error | a mounted page needs an object not in `consumer.routes` |
| `grant-unknown-tool` | error | `assistant.allowedTools` names a slug not in the catalog |
| `descriptor-invalid` | error | an installed descriptor fails schema or reference validation |
| `descriptor-core-range` | warning | installed core outside the descriptor's `requires.smrt` |
| `permissions-not-synced` | warning | catalog lacks manifest or descriptor slugs; recovery `smrt app permissions sync` |
| `page-shadowed` | warning | an app route takes a mounted page's path (the app wins) |
| `package-not-consumed` | info | a dependency ships a descriptor or manifest but is not consumed |
| `tools-not-granted` | info | suggested tools of a mounted preset that are not granted |
| `ejected-part-behind` | info | an ejected or extended file records an older package version |
| `retained-package-data` | info | tables of a package no longer consumed (kept by design) |

The doctor work also covers a gap found here: `smrt doctor` fails a
preset-based app (`Missing smrtPlugin`, decorator transform not configured)
because it greps `vite.config` for `smrtPlugin` and the `oxc` block, which the
`smrt()` preset supplies.

### 6. Coverage today

From the survey ([Appendix A](#appendix-a-package-survey)) of 71 workspace
packages: 42 publishable domain packages declare `@smrt()` models (344
classes), 17
register `ModuleUIRegistry` slots (117 slots), and **one package ships
mountable pages**: `smrt-content` has four self-loading route components with
route metadata (workspace, facts, governance, contributions) and one
props-driven article page. Seven packages ship page-sized components that are
props-driven (the host loads data and passes callbacks): `agents`, `assets`,
`content` (managers), `jobs`, `marketing`, `messages`, `sales`. No domain
package declares WebMCP view intents or shell dock tools; `smrt-chat`'s
`AssistantDock` is the only dock-ready component. No package needs file
migrations (schema is manifest-driven; `content` and `messages` carry legacy
SQL files that nothing applies).

So on day one, mount covers **wiring for all 42 model packages** (implicit
wiring-only descriptor) and **pages for `smrt-content`**. Each other package
gains pages when it ships a page surface: a component plus a server `load`
from a server subpath. That is package work, tracked per package, not CLI work.

### CLI contract

```text
smrt add <pkg>[@<range>] [--preset <name>] [--extend <Model> [--as <Name>] [--strategy sti|reference]]
         [--eject <part>]... [--grant <tool>]... [--plan | --apply [--expected-plan sha256:<hex>]] [--json]
smrt remove <pkg> [--keep-dependency] [--prune-grants] [--plan | --apply [--expected-plan sha256:<hex>]] [--json]
smrt app permissions sync [--plan | --apply]
smrt doctor --packages [--json]
```

- **Plan is the default.** Without `--apply`, nothing is written. To read a
  package that is not installed, the plan fetches its tarball without
  installing or running scripts and reads `package.json`, `smrt-package.json`,
  `dist/manifest.json` and `dist/smrt-knowledge.json`.
- **Apply verifies the plan.** `--apply` recomputes the plan; with
  `--expected-plan` it refuses on any difference (the
  `db:permissions --expected-fingerprint` pattern). Interactive apply prints the
  plan and asks; a non-interactive apply requires `--expected-plan`.
- **Apply order:** dependency (exact version and integrity from the plan) →
  config edit → extension and eject files → `smrt app build` →
  `smrt app migrate` (refuses while the local app runs, as today) →
  `smrt app permissions sync` (additive, never prunes) → re-plan, which must be
  empty. Files come before the build because the build is what puts an
  `--extend` model into `.smrt/manifest.json`; migrating first would leave the
  new table or STI columns out of that migration and the final plan non-empty.
- **Resuming.** Each step is detected as done from state, not from a log, so
  running the same command again after an interruption continues from the
  first unfinished step:

  | Interrupted after | A re-run sees | and does |
  | --- | --- | --- |
  | dependency | the planned version installed with the planned integrity | skips it; edits config |
  | config edit | every planned config entry present | skips it; writes files |
  | extension/eject files | each planned file present with its ownership header naming this package, model or part and strategy | skips it (never rewrites, even if edited since); builds. A file at that path without that header blocks (exit 2). |
  | build | nothing to detect; the build is repeatable | builds again, then migrates |
  | migrate | `smrt db:migrate --dry-run` reports nothing pending | skips it; syncs permissions |
  | permissions sync | no catalog slug or default grant missing | skips it; re-plans |

  The final re-plan runs only when every step reports done, and it must come
  back empty.
- **Config edits** go through a literal-only editor of `smrt.config.ts`: it
  adds or removes array items and object keys inside `defineConfig({...})`
  literals and preserves the rest. A non-literal config is refused, with the
  snippet to paste.
- **Parts for `--eject`:** `page:<id>` (route files at the mounted path),
  `dock:<id>` (a dock component wrapper in the layout); `nav` is not ejectable,
  `consumer.mount[pkg].exclude` hides a page.

Human output lists steps in a fixed kind order, ids sorted, no timestamps:

```text
$ smrt add @happyvertical/smrt-content
Plan sha256:<hex> — @happyvertical/smrt-content@0.55.0, preset workspace

dependency    + @happyvertical/smrt-content@0.55.0 (integrity sha512-<hex>)
blocked       ! build scripts need your decision: onnxruntime-node, tesseract.js (pnpm approve-builds)
config        + consumer.packages  @happyvertical/smrt-content
              + consumer.routes    @happyvertical/smrt-content:Content
              + consumer.mount     @happyvertical/smrt-content { preset: "workspace" }
schema        smrt app migrate: 15 tables declared (content_assets, content_contributions, …)
permissions   smrt app permissions sync: 217 slugs (contentcontributions.create, …)
page          + content.article    /articles/[slug]  requires contents.read
page          + content.workspace  /content          requires contents.read  nav "Content"
assistant     - contents.read  read  not granted  (--grant contents.read)
files         none

Apply: smrt add @happyvertical/smrt-content --apply --expected-plan sha256:<hex>
```

`--json` prints one object with `"schemaVersion": 1`, `command`, `package`,
`version`, `integrity`, `preset`, `planDigest`, ordered `steps` (each with
`kind`, `action`, and its fields), `blocked`, `files`, and
`"secretValuesIncluded": false`. The digest is SHA-256 over the canonical JSON
(sorted keys) of everything except `planDigest`.

Exit codes: `0` success or nothing to do; `1` error (invalid descriptor,
unresolvable package, refused config edit, digest mismatch); `2` blocked (a
`blocked` step such as a build-script decision, a running app, or a remove
blocker). `--plan --check` exits `3` when the plan is not empty, so CI can
assert that an applied add is still in place.

### Invariants

1. **Fail-closed grants.** No assistant tool is granted by `add`, a preset or
   an upgrade unless named with `--grant`; suggestions are never grants;
   `remove` only narrows.
2. **Declared exposure.** REST routes exist only for `consumer.routes`; every
   page declares `permissions`, enforced on the server before its `load` and
   actions; nav filtering is presentation only.
3. **No copied glue by default.** `add` changes `smrt.config.ts` and, through
   the package manager, `package.json`, the lockfile and its policy file.
   Source files appear only for `--extend` or `--eject`, carry an ownership
   header, and are never rewritten.
4. **Deterministic plan.** The plan reads files only, runs no package code, is
   stably ordered and digest-addressed; apply refuses a different plan.
5. **Idempotent apply.** Re-running a successful apply yields an empty plan.
6. **No data loss on remove.** Nothing drops tables, columns, rows or runs a
   destructive migration; retained data is reported.
7. **Runtime never creates application schema.** Schema changes go through
   `smrt app migrate` under its writer lease.
8. **Supply-chain decisions stay with the developer.** `add` never approves
   build scripts or widens release-age policy; pnpm's prompts become `blocked`
   steps.
9. **Tenancy unchanged.** Mounted pages use the same session handler and
   tenant context as app routes; scaffolds copy the target's tenancy mode.

## Consequences

- The template carries three one-line catch-all files and no per-package files;
  a package upgrade changes mounted pages without regenerating anything.
- Packages own more: a descriptor, page surfaces that accept mount-computed
  hrefs and API bases instead of hard-coded `/api/v1` and default paths, server
  loaders on a server subpath, and exported serializers.
- `smrt.config.ts` becomes the one place to review what an app consumes,
  exposes and grants.
- Pages that need their own page options, layouts or types are ejected and
  then owned by the app.

## Implementation issues

In dependency order; each names its invariants and acceptance criteria.

1. [#3559](https://github.com/happyvertical/smrt/issues/3559) descriptor and consumer config contract (types, schema, validator, `consumer.routes` / `consumer.mount` / `assistant.allowedTools`).
2. [#3560](https://github.com/happyvertical/smrt/issues/3560) `smrt add <pkg>` plan/apply and `smrt app permissions sync`.
3. [#3561](https://github.com/happyvertical/smrt/issues/3561) registered-page catch-all mount and preset hosting of package routes.
4. [#3562](https://github.com/happyvertical/smrt/issues/3562) `smrt remove <pkg>`, doctor package drift, the manifest-merge fix.
5. [#3563](https://github.com/happyvertical/smrt/issues/3563) `--extend` and `--eject` scaffolds.
6. [#3564](https://github.com/happyvertical/smrt/issues/3564) smrt-content reference descriptor going live and starter adoption.

## Alternatives rejected

- **Install script per package** — no plan, no safe re-run, no removal or
  drift detection, and arbitrary code at install time (owner decision).
- **Copy pages and components into the app** — recreates the problem #3367
  removes, one package at a time.
- **`package.json#smrt` or `manifest.json` as the descriptor home** — see
  section 1.
- **Generated thin route files as the default** — see section 2; kept as eject.
- **Auto-granting read-only tools** — fail-closed means the developer names
  every tool, whatever its effect.

## Open questions

1. **Public pages.** The catch-all requires a signed-in principal. Anonymous
   pages (a published article on a hosted profile) need a `public` page flag
   and a profile rule; not decided.
2. **Navigation round trip.** Whether a universal-only fast path (#3061) can
   apply to mounted pages without a server load, given the catch-all's server
   node, was not measured.
3. **Server endpoints.** Package-provided handlers (`mountAssistantRoutes`,
   MCP, runtime health, `.well-known`) are not pages; whether they mount through
   generated `+server.ts` re-exports or a `handle` dispatch was not prototyped.
4. **Agent exposure of hosted package models.** Generated WebMCP definitions
   cover only app-local objects (only `note_*` in the hand-add); whether
   `consumer.routes` should also emit WebMCP and MCP definitions is open.
5. **Transitive packages.** `content` built and migrated with only itself
   added although its models reference `assets`, `facts`, `messages` and
   `profiles` (only `profiles` was already consumed);
   `requires.packages` covers declared needs, inference from
   `smrtDependencies` is undecided.
6. **Role matrix on late adds.** `permissions sync` applies the default role
   matrix, so member and viewer gain the package's default grants, as on a
   fresh setup. Confirm that is wanted.
7. **Config editor dependency.** A literal-only `smrt.config.ts` editor may
   need an AST library; that is a dependency decision for the implementation.

## Appendix A: package survey

Counted from `packages/*/src` excluding tests and package-local `src/routes`
dev apps (method: `grep`/`find`, 2026-10-06, `main` at v0.54.4). Columns: `@smrt`
classes; UI subpaths in `exports`; `ModuleUIRegistry` slots declared in
`src/ui.ts`; page-sized components (`*Route`, `*Page`, `*Dashboard`,
`*Manager`, `*Portal`, `*Inbox`, `*AdminPanel`); exported SvelteKit handler
factories (`mount*`, `create*Handler/Load/Route`); `registerPermissionDefinitions`
calls; legacy SQL files. Only publishable packages with models or a UI subpath
are listed. No domain package declares `defineIntent`, `definePlaybook` or a
shell dock tool, so those columns are omitted.

| Package | Models | UI subpaths | Slots | Page-sized | Handlers | Perm. reg. | SQL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ads` | 5 | — | 0 | 0 | 0 | 0 | 0 |
| `agents` | 7 | ui, svelte | 5 | 2 props | 0 | 0 | 0 |
| `analytics` | 4 | ui, svelte | 6 | 0 | 0 | 0 | 0 |
| `app-runtime` | 0 | sveltekit | 0 | 0 | 4 | 0 | 0 |
| `assets` | 9 | ui, svelte | 10 | 1 props | 0 | 0 | 0 |
| `chat` | 8 | sveltekit, ui, svelte | 7 | 0 (+ `AssistantDock`) | 3 | 0 | 0 |
| `commerce` | 26 | svelte | 22 | 0 | 0 | 0 | 0 |
| `content` | 22 | ui, svelte | 3 | 4 mountable + 1 props route, 5 props | 1 | 0 | 1 |
| `events` | 7 | ui, svelte | 1 | 0 | 0 | 0 | 0 |
| `expenses` | 4 | ui, svelte | 5 | 0 | 0 | 0 | 0 |
| `facts` | 7 | — | 0 | 0 | 0 | 0 | 0 |
| `features` | 2 | svelte | 0 | 0 | 0 | 0 | 0 |
| `fields` | 9 | svelte | 0 | 0 | 0 | 1 | 0 |
| `human-resources` | 12 | ui, svelte | 4 | 0 | 0 | 0 | 0 |
| `images` | 1 | ui, svelte | 3 | 0 | 0 | 0 | 0 |
| `inventory` | 3 | svelte | 0 | 0 | 0 | 0 | 0 |
| `jobs` | 6 | ui, svelte | 6 | 1 props | 0 | 0 | 0 |
| `languages` | 2 | — | 0 | 0 | 0 | 0 | 0 |
| `ledgers` | 3 | — | 0 | 0 | 0 | 0 | 0 |
| `manufacturing` | 7 | ui, svelte | 7 | 0 | 0 | 0 | 0 |
| `marketing` | 3 | svelte | 0 | 1 props | 0 | 0 | 0 |
| `messages` | 17 | ui, svelte | 9 | 2 props | 0 | 1 | 1 |
| `personas` | 3 | svelte | 0 | 0 | 0 | 1 | 0 |
| `places` | 4 | — | 0 | 0 | 0 | 0 | 0 |
| `playbooks` | 1 | — | 0 | 0 | 0 | 0 | 0 |
| `products` | 7 | `./components` | 0 | 4 (not exported) | 0 | 0 | 0 |
| `profiles` | 19 | — | 0 | 0 | 1 | 0 | 0 |
| `projects` | 15 | ui, svelte | 16 | 0 | 0 | 0 | 0 |
| `prompts` | 1 | svelte | 0 | 0 | 0 | 0 | 0 |
| `properties` | 2 | — | 0 | 0 | 0 | 0 | 0 |
| `reports` | 6 | — | 0 | 0 | 0 | 0 | 0 |
| `sales` | 28 | svelte | 0 | 2 props | 0 | 0 | 0 |
| `secrets` | 3 | — | 0 | 0 | 0 | 0 | 0 |
| `sites` | 2 | — | 0 | 0 | 0 | 0 | 0 |
| `smrt-app-mcp` | 0 | sveltekit | 0 | 0 | 5 | 0 | 0 |
| `social` | 4 | svelte | 0 | 0 | 0 | 0 | 0 |
| `subscriptions` | 11 | svelte | 0 | 0 | 0 | 0 | 0 |
| `support` | 17 | svelte | 0 | 0 | 0 | 1 | 0 |
| `tags` | 2 | — | 0 | 0 | 0 | 0 | 0 |
| `tenancy` | 1 | ui, svelte | 2 | 0 | 0 | 0 | 0 |
| `timesheets` | 8 | ui, svelte | 5 | 0 | 0 | 0 | 0 |
| `users` | 22 | sveltekit, svelte | 6 | 0 | 8 | 3 | 0 |
| `video` | 21 | — | 0 | 0 | 0 | 0 | 0 |
| `voice` | 3 | — | 0 | 0 | 0 | 0 | 0 |

"Mountable" means the component loads its own data from REST and needs only
`consumer.routes` and props; "props" means the host must load data and pass
callbacks. `cli` (1 model) and the UI and tooling packages (`smrt-ui`,
`smrt-svelte`, `smrt-playground`, `smrt-workbench`, `vitest`) are infrastructure
and not candidates for `smrt add`.

## Appendix B: hand-add record

`@happyvertical/smrt-content@0.54.3` into a copy of `smrt-start` (s-m-r-t
0.54.3, local profile, isolated `XDG_*` directories, owner claimed first). Each
step names the descriptor key or CLI step it fixes.

| # | Step the developer took | Evidence | Becomes |
| --- | --- | --- | --- |
| 1 | `pnpm add @happyvertical/smrt-content@0.54.3`: pnpm added 7 `minimumReleaseAgeExclude` entries and exited 1 on ignored build scripts (`onnxruntime-node`, `tesseract.js`); set both `false` in `allowBuilds`, deleted pnpm's placeholder lines, reinstalled (exit 0, +485 packages) | install logs | dependency step; `blocked` build-script decision (invariant 8) |
| 2 | Added the package to `consumer.packages` | build lists 8 s-m-r-t dependencies | config: `consumer.packages` |
| 3 | `smrt app migrate`, refused until the dev server was stopped (writer lease); then 18 migrations, 15 `content_*`/`contents` tables. Before it, `app doctor` reported `migration-required` | migrate log | schema step |
| 4 | Owner predated the package: catalog had 0 `contents.*` slugs, owner 0 grants. No command re-seeds; wrote a temporary route calling `RoleCollection.seedSystemRoles({ seedPermissions: true })` → 217 `content*` slugs, owner holds 77 `contents.*` | SQLite queries | `smrt app permissions sync` |
| 5 | The `smrt()` preset passes `svelteKit: true`, so dependency REST routes cannot be hosted; replaced it with a hand-written `smrtConsumer` + `smrtPlugin` config (49 lines, a second copy of the package list). Sharing `src/routes/api` failed (`Incompatible SvelteKit route settings`: the consumer cannot set `objectsDir`), nesting `api/v1` failed (`nested routesDir ownership`), a disjoint `src/routes/pkg-api` worked (22 generated routes) | build logs | config: `consumer.routes`, read by the preset; page `routes`; `$mount: routesBase` |
| 6 | Build failed `UNLOADABLE_DEPENDENCY $lib/server/content-api-serializers`: `Content`'s API config names an app path for its item serializer and the package does not export `serializeContent`; wrote one | build log | package fix (reference-package follow-up) |
| 7 | Wrote `src/routes/content/+page.svelte` and `+page.server.ts` (sign-in and `contents.read` gate), with `apiBaseUrl="/pkg-api"` | page 200, REST list/create 200 | page `component`, `permissions`, catch-all |
| 8 | Added `{ href: '/content', label: 'Content' }` to the layout's `nav` | Playwright: nav link reaches the page | page `nav` |
| 9 | The workspace linked to `/workspace`, `/facts`, `/governance`, `/contributions` (package defaults, 404 in the app); passed `navigation={createContentRouteNavigation({...})}` filtered to mounted pages | Playwright link list before and after | `$mount: navigation`, `href:<id>` |
| 10 | Added `contents.read` to `allowedTools` in the assistant route; exporting the list from `+server.ts` failed `pnpm build` (`Invalid export`), so it needed an `_` prefix | granted catalog = `contents.read`, `notes.create`, `notes.read` | `assistant.allowedTools` config, `--grant` |
| 11 | WebMCP: none possible; the package declares no intents and generated definitions cover only app objects (`note_*`) | virtual module contents | `webmcp.intents`; open question 4 |
| 12 | Dock tools: none; the package's editor "tools" are focus-rail tools, not shell dock tools | survey | `dock` (kept for `smrt-chat`) |
| 13 | MCP `/mcp`: `models: [Note]` unchanged; adding content would be another explicit edit | route file | listed in plan, not changed |
| 14 | Package config: none read by `smrt-content` | `getPackageConfig` survey | `config` |

Result: `pnpm typecheck` 0 (svelte-check 0 errors in 2,290 files), `pnpm test`
4 files, 11 tests passed, `pnpm build` 0 (after step 10's fix). Removal
(content dropped from `consumer.packages`, preset restored): build 0 and the
generated `pkg-api` files removed (empty directories left), but
`.smrt/manifest.json` kept 33 content objects and the pages, REST and grant
kept working until `.smrt` was deleted; `smrt app migrate` then reported the
schema up to date and left the 15 tables and their row intact; `smrt app doctor`
reported `ready` with no findings; `smrt doctor` exited 1 on the preset checks
in section 5.

## Appendix C: catch-all prototype

In the same throwaway app, `src/routes/[...module]/` with hand-written tables
standing in for the generated virtual modules, mounting `content.workspace`
(`/content`), `content.article` (`/articles/[slug]`, server load) and a test
page with a form action, plus a page requiring a permission the owner lacks.

| Check | Dev | Build (`app:start`) |
| --- | --- | --- |
| `/`, `/settings` still served by the app routes | 200, 200 | 200 |
| `/content` SSR and hydrated workspace lists the created record | 200 | 200 |
| `/articles/hello` SSR HTML contains the body (server load + dynamic component) | 200 | 200 |
| `/articles/missing`, `/nope/deeper` | 404, 404 | 404 |
| Page whose permission the owner lacks | 403 | 403 |
| Anonymous `/content` | 303 → `/setup` | — |
| Action on its page; with invalid input; on another page; anonymous; unknown name | 200 success; `fail(400)`; 404; 401; 404 | enhanced submit, no full navigation |
| Client navigation from the shell nav | reaches `/content` | — |
| `pnpm typecheck` (`svelte-check`), `pnpm test` | 0, 11 passed | — |
| Catch-all client node size, package UI chunks lazy | 1.8 KB | — |

## Appendix D: TypeScript types

```ts
/** `smrt-package.json`; mirrors 0003-smrt-package.schema.json. */
export interface SmrtPackageDescriptor {
  $schema?: string;
  $comment?: string;
  descriptorVersion: 1;
  /** Must equal package.json `name`. */
  package: string;
  requires?: { smrt?: string; packages?: string[] };
  permissions?: SmrtDescriptorPermission[];
  /** Browser subpaths whose import registers ModuleUIRegistry slots. */
  ui?: { register?: string[] };
  pages?: SmrtDescriptorPage[];
  dock?: SmrtDescriptorDockTool[];
  assistantTools?: Array<{ tool: string; reason: string }>;
  webmcp?: { intents?: string[] };
  config?: { key: string; defaults?: Record<string, unknown> };
  extensions?: Array<{
    model: string; // provider-qualified
    strategies: Array<'sti' | 'reference'>;
    description?: string;
  }>;
  presets: Record<string, SmrtDescriptorPreset>;
  defaultPreset: string;
}

/** `<exports subpath>#<named export>`, e.g. `./svelte#ContentWorkspaceRoute`. */
export type SmrtExportRef = `.${string}#${string}`;

export type SmrtMountValue =
  | { $mount: 'routesBase' }
  | { $mount: 'navigation' }
  | { $mount: `href:${string}` };

export interface SmrtDescriptorPage {
  id: string;
  title: string;
  description?: string;
  /** Default mount path; `[param]` segments only. */
  path: string;
  component: SmrtExportRef;
  /** Server-only subpath; result becomes the component's `data` prop. */
  load?: SmrtExportRef;
  actions?: SmrtExportRef;
  /** All required; `[]` means any signed-in user. */
  permissions: string[];
  /** Objects whose REST routes the page calls. */
  routes?: string[];
  packages?: string[];
  props?: Record<string, SmrtMountValue | unknown>;
  nav?: false | SmrtRouteNavigationMeta;
  /** Non-default values require `--eject page:<id>`. */
  render?: { ssr?: boolean; csr?: boolean };
}

export interface SmrtDescriptorDockTool {
  id: string;
  label: string;
  component: SmrtExportRef;
  permissions: string[];
  props?: Record<string, SmrtMountValue | unknown>;
  order?: number;
}

export interface SmrtDescriptorPermission {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  defaultRoles: Array<'owner' | 'admin' | 'member' | 'viewer'>;
}

export interface SmrtDescriptorPreset {
  description: string;
  pages: string[];
  dock?: string[];
  routes?: string[];
  packages?: string[];
  /** Listed in the plan; still not granted. */
  assistantTools?: string[];
  config?: Record<string, unknown>;
}

/** Additions to `SmrtConfig` in @happyvertical/smrt-config. */
export interface SmrtConsumerConfig {
  packages?: string[];
  /** Provider-qualified objects whose generated REST routes the app hosts. */
  routes?: string[];
  mount?: Record<
    string,
    { preset?: string; paths?: Record<string, string>; exclude?: string[] }
  >;
}

export interface SmrtAssistantConfig {
  /** Fail-closed: absent or empty means no tools. */
  allowedTools?: string[];
}
```

`SmrtRouteNavigationMeta` is the existing type in
`packages/types/src/routes.ts`; `SmrtRouteDefinition` and `SmrtRouteModule` in
the same file are superseded for mounting by descriptor pages, and the
reference package's `CONTENT_ROUTE_META` should be checked against its
descriptor rather than maintained separately.
