# smrt-planner

`@happyvertical/smrt-planner` lives in the
[smrt monorepo](https://github.com/happyvertical/smrt) at `packages/planner`
and releases in lockstep with every other `@happyvertical/smrt-*` package.
(It used to live in `happyvertical/smrt-planner`, on its own 0.1.x line; that
repository is archived.)

A static demo of [s-m-r-t](https://github.com/happyvertical/smrt). Add recipes
(Customers, Sales, Purchases, ...) or whole packages and an app mock-up assembles around them: a
shell with navigation, a list view and create/edit form per model with sample
data, and a plain-language Help page per recipe that follows the app's options,
with a collapsed "Connect other tools" section listing the REST routes, MCP
tools and CLI commands s-m-r-t generates from each model's decorator.

It is a purely static site (SvelteKit + `adapter-static`). Nothing is
installed or stored on a server; sample data lives in memory and resets on
reload. The layout comes from the canonical starter,
[smrt-start](https://github.com/happyvertical/smrt-start), minus everything
server-side.

## Run it

From the root of an smrt checkout (Node.js 26+, pnpm from the root
`packageManager`). The planner's catalog is generated from the workspace's
built manifests, so build the workspace once first:

```bash
pnpm install
pnpm turbo run build --filter=@happyvertical/smrt-planner...
pnpm --filter @happyvertical/smrt-planner dev    # http://localhost:5173
```

The build writes the static site to `./build` (servable from any static host,
or `pnpm --filter @happyvertical/smrt-planner preview`) and copies it into
`./app` for the package.

Hosting under a sub-path (for example GitHub Pages)? Build with
`BASE_PATH=/smrt-planner pnpm build`.

## Use it

1. On the Planner page, add recipes: small units like Customers, Vendors,
   Sales (needs Customers) and Purchases (needs Vendors). Adding one also adds
   what it requires. The whole package catalog is still there under "All
   packages".
2. A recipe opens an options form built from its models' own parameters:
   switch fields on or off (required ones stay on), set label, help text,
   default value and order, and narrow REST, MCP and CLI exposure. Saving writes
   field policies in the `@happyvertical/smrt-fields` shape, held in memory for
   now.
3. The left navigation grows a group per recipe with its entries (Customers,
   Sales Orders, ...). Open one to browse sample rows and create, edit or
   delete them. The generated views and each recipe's Help page (overview,
   tasks and a field glossary) follow the options: hide a field and its
   glossary entry and any task step about it disappear. Money fields are stored as integer minor units (cents).
4. Recipes and options live in the URL (`?r=commerce.sales,...&o=...`); copy it
   to share the mock-up.

Short on time? The **Cookbooks** tab (where a first visit lands) offers ready-made
starting points for a bakery, a mechanic, a welder and a yoga studio: pick one,
read what it adds (recipes, menu, default payment terms, currency and tax), and
use it to replace your recipes and menu. Your records stay.

The Assistant runs a small model on your device. The chat icon at the end of
the header opens it once a model is ready; before that it opens the AI models
page (`/ai/`), so a first click sets inference up instead of showing an empty
chat. Three icons in the left sidebar footer show **Think** (the language
model), **Hear** (voice typing) and **Speak** (read replies aloud); each opens
the same page, where you choose and download them. A first visit with nothing built starts there; "I don't
need AI, let's just build" skips it for good. Live s-m-r-t objects are tracked in #4.

Generated record forms use the Planner's own responsive, open form layout.
Generated record lists let you sort any data column by selecting its heading;
select it again to reverse the order. Sorting changes only the current view.
The left sidebar starts open, with inference controls above the user menu in
its footer. The Theme tab offers palette previews, large appearance choices,
a brand colour wheel and font selection. **Advanced Styles** opens a dedicated
CSS editor with syntax highlighting. CSS applies to the Planner as it changes
and travels with the cookbook when saved, exported or imported.

## Install the package

The primary package registry is `npm.happyvertical.com`. Configure the scope
once, then install the planner:

```bash
pnpm config set @happyvertical:registry https://npm.happyvertical.com/
pnpm add @happyvertical/smrt-planner
```

The same version is mirrored to npmjs on a best-effort basis. Install the
planner at the same version as the rest of your smrt packages: they release
together as one line. `Planner` mounts
the cookbook-driven app shell and its customization controls. A host can drive
it with the typed command set:

```svelte
<script lang="ts">
import { Planner, createPlannerController } from '@happyvertical/smrt-planner';

const controller = createPlannerController();
</script>

<Planner {controller} basePath="/planner" />
```

`Planner` props, all optional: `controller`, `basePath` (where its pages are
served from), `persistence` (`'self'` reads and saves the cookbook in this
browser, `'host'` leaves both to you), `themeControls`, `defaultTitle` (the shell title when no cookbook name or
library cookbook applies; defaults to `'Planner'`), `tabs`, `onready`, and:

The mounted planner is the framework's cookbook-driven app shell with its
customizable overviews switched on: the pencil at the start of the header
edits the menu and every section page in place (add, move, resize, configure
and remove widgets), and each edit lands in the cookbook's `layout` and
`overviews`, so it is saved, exported and imported with the rest of the plan.
The `metric`, `records` and `chart` widgets read the in-browser sample data;
the chart groups the seeded rows itself (by a field, or a date field bucketed
over the widget's period) as the stand-in for the runtime report a generated
app's chart loader would compile. Its pages are fragment routes (`#/s/...`,
`#/m/...`, `#/packages/...`), so the mount needs nothing from the host's
router and every in-planner link stays inside it.

- `backLink: { href, label }` renders a link out of the planner at the start
  of its header, beside the brand (a docs site's "Back to documentation").
- `inference` gives the planner's assistant a model and switches the assistant
  on: the chat icon at the end of the header opens the chat dock once a model
  is ready, and the AI models page (`#/ai/`) before, where a visitor downloads
  a browser model or connects their own endpoint. Pass the same object as
  `planner.config.json`'s `inference` (`{ mode, alternatives?,
  credentialPersistence?, host?, byo? }`, see `docs/inference-host.md`) or
  `{ chat }` with a model of your own. For a public site where visitors bring
  their own endpoint: `inference={{ mode: 'byo', alternatives: ['browser'],
  credentialPersistence: 'memory' }}`. Without `inference` the planner has no
  assistant and no chat icon.

```svelte
<Planner
  basePath="/planner"
  backLink={{ href: '/', label: 'Back to documentation' }}
  inference={{ mode: 'byo', credentialPersistence: 'memory' }}
/>
```

Hosts that already own an `AppShell` can mount `PlannerControls` inside it.
The controls are the reusable part; `Planner` remains the complete shell.
Use the exported shell defaults to start navigation open, with inference
controls above the user menu in its footer. The bottom panel starts hidden.

```svelte
<script lang="ts">
  import { AppShell } from '@happyvertical/smrt-svelte/app';
  import {
    PLANNER_SHELL_EDGE_TOGGLES,
    PLANNER_SHELL_PANEL_DEFAULTS,
    PlannerControls,
  } from '@happyvertical/smrt-planner';
</script>

<AppShell
  edgeToggles={PLANNER_SHELL_EDGE_TOGGLES}
  config={PLANNER_SHELL_PANEL_DEFAULTS}
  layoutEditing
>
  <PlannerControls layout="shell" persistence="host" />
</AppShell>
```

```ts
import { commandTools, createPlannerController } from '@happyvertical/smrt-planner/commands';

const controller = createPlannerController();
const result = controller.run({
  name: 'add_recipes',
  input: { ids: ['commerce.sales'] },
});
// { ok: true, snapshot, receipt } | { ok: false, error: { code, message } }
controller.subscribe((snapshot) => render(snapshot));
```

`commandTools` is every command as `{ name, description, inputSchema }`: pass it
straight to an LLM or an MCP server as tool definitions. `controller.snapshot()`
is a compact read-only plan (a few KB) fit for a model prompt. Commands:
`add_recipes`, `remove_recipes`, `add_features`, `remove_features`,
`add_cookbook`, `remove_cookbook`, `apply_cookbook`, `import_cookbook`,
`set_settings`, `set_policy`, `set_theme`, `reset_theme`, `rename_section`,
`rename_item`, `hide`, `show`, `focus`, `export_cookbook`, `undo`.

`@happyvertical/smrt-planner` and `@happyvertical/smrt-planner/commands` are Svelte source (runes) and JSON,
so consume them through Vite or another Svelte-compiling bundler. A plain Node
server uses `@happyvertical/smrt-planner/core` instead (command schemas, the assistant prompt,
reply validation, the library catalog) and can serve the prebuilt app from
`@happyvertical/smrt-planner/app`; see `docs/inference-host.md`.

## How the catalog is generated

`src/lib/catalog/catalog.json` is the only thing the app reads. It is
**generated by `pnpm build` and never committed**, from the same workspace the
release publishes, so a released planner always describes exactly the packages
released beside it:

```bash
pnpm --filter @happyvertical/smrt-planner catalog:generate
```

The script (`scripts/generate-catalog.ts`):

1. Reads every public `@happyvertical/smrt-*` package in the workspace that
   exports `./manifest.json`, from its built manifest and the
   `smrt-knowledge.json` beside it. Each of those packages is a devDependency
   of the planner, so Turbo builds them first; a declared but unbuilt manifest
   fails the build rather than silently shrinking the catalog. Packages
   without a manifest export (cli, svelte, ui, ...) or without models are
   skipped.
2. Drops the infrastructure packages in
   `src/lib/catalog/generate/exclusions.ts` (core, tenancy, jobs, prompts,
   ...); that list is the only hand-maintained part, and each entry says why.
   A listed package that declares recipes stays (`smrt-chat` brings the
   assistant, `smrt-fields` form customization): a recipe is a feature.
3. Writes, per package: description, models, each model's fields and types, the
   generated REST routes, MCP tools and CLI commands (from the knowledge
   artifact's `surfaces`), public methods and which are AI-callable (have an MCP
   tool), the recipes it declares with their surfaces, providers (secret
   names only), runtime, demo seed and browser-demo mode (`demo`, plus the
   package's `browser` capability; smrt#3708/#3709), and dependencies (the
   manifest's `smrtDependencies` plus models' foreign keys and cross-package
   references, limited to catalog packages).

Output is sorted and has no timestamps or checkout paths, so a build of the
same tree is byte-identical anywhere. `CATALOG_SOURCE=registry` reads the
published packages from the registry instead (`SMRT_PLANNER_REGISTRY`
overrides it), and `CATALOG_SOURCE=<path>` another smrt checkout, to compare.

Because the library cookbooks are validated against this catalog in the
planner's tests, a framework change that breaks a cookbook (a field moved out
of a model, a recipe renamed) fails the pull request that makes it.

## Scripts

Run with `pnpm --filter @happyvertical/smrt-planner <script>`.

| Script | Does |
| --- | --- |
| `dev` | Vite dev server |
| `build` | Catalog and CLI version from the workspace, the static app into `build/` and `app/`, the MCP widget `app/mcp.html`, then `svelte-package` into `dist/` |
| `verify:pack` | `publint` and the monorepo's packed-exports check |
| `catalog:generate` | Regenerate the catalog alone |
| `typecheck` | `svelte-kit sync`, `tsc`, `svelte-check` |
| `test` | Vitest, including every library cookbook validated against the workspace catalog |
| `test:mcp-browser` | Rebuild `app/mcp.html` and drive it in Chromium |
| `test:live-preview-browser` | Drive the live preview against the dev server in Chromium |
| `test:package -- <tarball>` | Install and exercise an already packed tarball as an isolated consumer |

Lint and formatting are the monorepo's root `pnpm lint`. The package is
released by the monorepo's batched release with every other smrt package (see
the root `CHANGESETS.md`); it is never published on its own.

## License

MIT © Happy Vertical Corporation

### Native host context and Export actions

A mounted complete `Planner` can retain an earlier conversation and add its
host's first Export action while keeping the native cookbook download:

```svelte
<Planner
  inference={{ mode: 'host', host: { endpoint: '/api/planner/chat' } }}
  initialConversation={{
    id: 'stable-handoff-id',
    messages: [{ role: 'user', content: 'I run a repair workshop.' }],
  }}
  cookbookOffers={false}
  exportAction={{
    label: 'Continue with this app',
    run: async ({ export: file, revision, conversation }) => {
      // file is the existing ExportData: fileName, exact text, full cookbook.
      // Store/submit the detached context according to your host's policy.
      await savePlan({ file, revision, conversation });
    },
  }}
  onready={({ nativeAssistant }) => {
    // The same transport the visible native dock uses, not `assistant`.
    nativeAssistant?.subscribeConversation((messages) => remember(messages));
  }}
/>
```

`onready.openAssistant()` opens and focuses the ready native dock using the
shell API and returns false if the dock/model is unavailable. It waits a Svelte
tick so shell registration can settle; seeding alone never opens the dock.

`onready.nativeAssistant` exposes `conversation()` (a detached full current
thread), `subscribeConversation(listener)` (immediate snapshot; returns an
unsubscribe), `busy`, `seed({ id, messages })`, and the existing chat transport
methods. The legacy `onready.assistant` remains a separate host-driven assistant;
it is not a way to read the visible native dock's messages.

Seed accepts only plain user/assistant text. It appends the complete input in
one notification, never executes it, and returns false for a repeated id,
malformed input, an in-flight turn or a thread that has already received native
sends. Supply `initialConversation` before opening the native dock; seeding is
not a way to replace an active conversation. The host retains the original
transcript separately when original message identities/provenance matter.

`headerAction={{ label, run }}` adds a primary button to the complete Planner header.
It uses the same capture and busy/error safeguards as `exportAction`; hosts may
pass the same callback to both entry points. The Export shortcut and native
download remain available. `PlannerControls` does not render a header action.

`PlannerExportContext` is `{ export: ExportData, revision, conversation }`.
The Export action captures document and thread synchronously and rejects an
in-flight conversation rather than submitting a partial turn. Host callback
failures are displayed inline; download remains available. Conversation export
has no inference history truncation, including native tool data and error
messages. The inference wire still sends only bounded recent turns. No server
persistence, iframe bridge, automatic app generation, or custom model/recipe
creation is implied. Sample records remain outside the cookbook.

`cookbookOffers={false}` removes library cookbook proposals from the native
assistant's vocabulary/schema; existing recipe/feature composition remains
available. This defaults to true and does not remove the Cookbooks tab.
`PlannerControls` also accepts `exportAction`; without a complete Planner its
export conversation is empty because it owns no native dock.

### External assistant on the same live app

An external host assistant can drive `onready.controller` through a dedicated
`MessagePort` without using, seeding, or writing the native assistant thread.
The host must first authenticate its window handshake by exact origin **and**
expected `event.source`, then transfer a fresh `MessageChannel` port. The
library intentionally does not install a broad window message listener.

```ts
// Inside the mounted Planner host, after a trusted port transfer:
const binding = bindPlannerCommandPort({
  port,
  controller: handle.controller,
  allowedCommands: ['add_cookbook', 'add_recipes', 'add_features'],
  source: 'external-assistant',
});
// Call binding.invalidate() in the workspace's synchronous onreset callback.
// Call binding.dispose() before replacing/unmounting the mounted Planner.

// On the external assistant side, using the other dedicated port:
const client = connectPlannerCommandPort(otherPort);
const before = await client.snapshot();
// Prepare a hosted model reply from before.snapshot and this assistant's own
// conversation. context() additionally exposes the canonical catalog/tools.
const result = await client.applyReply({
  id: 'stable-request-id',
  generation: before.generation,
  expectedRevision: before.snapshot.revision,
  reply: hostedReply,
});
// Speak/display result.content: it comes from actual command receipts/coaching.
```

`snapshot()` and `subscribe()` expose `{ generation, snapshot }` from the actual
mounted controller, including manual edits. `context()` adds the package's
published `catalog` and `tools`. `execute()` accepts a typed command array;
`applyReply()` accepts only `{ reply, commands?, sampleContext? }`. The latter
validates fictional sample context before executing an atomic canonical batch,
then installs it only after successful changed commands and before the next
render. It reuses native command receipts and coaching, with no assistant thread.

Every mutation requires the observed generation and revision. The binding
assigns source attribution, namespaces command ids, deduplicates the whole
request, rejects id reuse with changed input, and refuses stale/reset requests.
Allowed commands are explicit (an empty list denies all mutations). Envelopes
are limited to 32 KiB, 16 commands and 128-character request ids. Each generation
retains at most 256 receipts; at capacity new requests are rejected, never
silently evicted/reexecuted. Reconnect/invalidate deliberately to renew the
capability. The client bounds pending calls to 32 and times out unanswered calls
after ten seconds; disposal rejects pending calls and closes the port.

`invalidate()` changes only the connection generation and receipt cache; it
never resets the app itself. The canonical workspace reset increments the
controller revision and invokes host `onreset` synchronously, so a host binding
invalidated there cannot accept a delayed pre-reset reply. Do not automatically
retry a conflict with a newer revision: inspect the current plan first. A host
using an older release must feature-detect these exports and report unavailable
Planner control honestly while its external conversation continues.
