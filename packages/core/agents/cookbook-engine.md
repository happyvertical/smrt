# Cookbook command engine (#3753)

`@happyvertical/smrt-core/cookbook/engine` (`src/cookbook/engine/`) is the one
place the rules for changing a [cookbook](cookbook.md) live. A planner UI, a
local Kitchen MCP server, the CLI and a website all call it; each is an adapter.
It imports only relative modules and `@happyvertical/smrt-types` types, so it
runs in Node and in a browser. No SvelteKit, storage, singleton or inference.

It lives in `smrt-core` because the contract and validator (`./cookbook`) do and
the package DAG forbids a back edge: types -> core. A separate package would add
a node for pure functions with no other dependency.

## API

```ts
import { createCookbookEngine } from '@happyvertical/smrt-core/cookbook/engine';
const engine = createCookbookEngine({ catalog, cookbook?, state? });
engine.run({ id?, name, input, expectedRevision? }) // CommandResult, never throws
engine.batch({ id?, commands, expectedRevision? })  // BatchResult, atomic
engine.snapshot() / .cookbook() / .state() / .subscribe(fn)
engine.tools / engine.batchTool                      // JSON Schema tool definitions
```

- **Catalog is data** (`EngineCatalog`): `recipes` (manifest `RecipeDefinition`
  fits), `models` (`id, name, packageId, exposed?, fields?`), optional
  `cookbooks` (a library), `themePresets`, `currencies`, `settingTargets`.
  Nothing is bundled. Build it from published manifests or `smrt-knowledge.json`.
- **Commands** (20, `COOKBOOK_COMMANDS_VERSION = 1`): `apply_cookbook` (select),
  `import_cookbook`, `add_cookbook`, `remove_cookbook`, `add_recipes`,
  `remove_recipes`, `add_features`, `remove_features`, `set_settings`,
  `set_policy`, `set_theme`, `reset_theme`, `set_name`, `rename_section`,
  `rename_item`, `hide`, `show`, `validate`, `export_cookbook`, `undo`. Navigation
  and focus are not commands: they are an adapter concern.
- **Errors** are typed (`CommandError`: `code`, `message`, `path?`, `details?`):
  `unknown_command`, `invalid_input`, `not_found`, `confirmation_required`,
  `conflict`, `id_reuse`, `batch_failed`, `failed`.
- **Result** carries the `receipt` (`name, id?, summary, changed, revisionBefore,
  revisionAfter, undoId?, changes?, warnings?`), the compact `snapshot` and
  optional `data` (`validate`, `export_cookbook`).

## Execution contract

- **Revisions** count applied changes (a no-op does not move it), so equal
  histories give equal revisions. `expectedRevision` that is not current fails
  `conflict` with `details.{expectedRevision,currentRevision}`: an older model
  action cannot overwrite a newer manual edit. Send it on every model action.
- **Command ids**: a repeated `id` with the same command returns the first
  result with `replayed: true` and applies nothing (failures replay too: take a
  new id after re-reading). The same id with a different command is `id_reuse`.
  The journal keeps `maxJournal` (500) ids and is part of `state()`.
- **Atomic batches** run on a working copy; one failure leaves the state
  byte-identical and returns `batch_failed` naming `details.index`. A batch that
  changes n times advances the revision by n, as n runs would, and has one undo.
  `undo` and per-command ids/revisions are not allowed inside a batch.
- **Undo** restores the document from before the change; it is a `conflict`
  while the plan differs from what that change left, unless `force`.
- **Recovery**: `state()` is plain JSON (revision, applied library id, document,
  journal); `createCookbookEngine({ catalog, state })` resumes it, retries
  included. Undo entries are not persisted.
- **Canonical document**: ids sorted, policies sorted, empty sections absent,
  key order fixed, so two engines export identical text. Recipe/feature ids the
  catalog lacks stay in the document and show as `snapshot.unavailable`.

## Deliberately not here

Package or starter version pinning (waits on #3604/#3754). Deep overview-widget
and nav-id checks (smrt-svelte owns them; `import_cookbook` carries `overviews`
and `layout` through unjudged, `validate` only flags layout ids the menu lacks).
Typed diagnostics from `validateCookbook` itself (#3754): `validate` wraps its
strings as `invalid_document` until it returns them.

## Becoming an adapter: what smrt-planner changes (after the smrt release)

Parity to hold: the planner's `tests/headless-planner.test.ts` scenario is
ported in `__tests__/engine.test.ts` (`SCRIPT`) over a data catalog.

1. Depend on the released `@happyvertical/smrt-core`; build `EngineCatalog` from
   its catalog data (`recipes.json`/`catalog.json` -> `recipes`, `models`,
   `cookbooks`: the library wrapper keeps id/icon/keywords planner-side).
2. Delete `commands/execute.ts`, `commands/runner.ts`, `commands/snapshot.ts`,
   `commands/schemas.ts` (keep `checkSchema` only if still used), `recipes/
   plan-data.ts`, `recipes/resolve.ts`, `settings/app-settings.ts` rules,
   `assistant/change.ts` apply* helpers, `cookbook/assemble.ts` and the
   `createPlainHost`. `createHeadlessPlanner` becomes `createCookbookEngine`
   behind the same `run/snapshot/subscribe/cookbook` names.
3. The browser controller keeps: `focus` and the planner tab/section cells
   (snapshot `focus` is added by the adapter), reactive wrapping of
   `engine.subscribe`, `onReplaced` (regenerate sample data after
   `apply_cookbook`), and the `cookbookStore` <-> `engine.state()` sync
   (`engine.cookbook()` to persist; rebuild with `cookbook`/`state` on load).
4. Command differences to absorb: `apply_cookbook`/`import_cookbook` report
   `changed` by content; `rename_*`/`hide`/`show` need the catalog `models`
   `packageId` for item ids; undo is whole-document (the old per-slice undo goes);
   `unsupported` is gone (the engine always has every slice); new `set_name`,
   `validate`; receipts gain `revisionBefore/After`; `expectedRevision` moves
   into the command (the option form still works).
5. Overview customisation stays a planner/smrt-svelte concern; hold `overviews`
   in the document via `import_cookbook` and write them with a planner-side
   command until an engine command is agreed.
6. MCP/Kitchen (#3752, done): `smrt kitchen mcp` holds one engine per plan id and
   serves `engine.batchTool`'s schema as `run_commands`; the plan reaches disk
   as `smrt.cookbook.json` through `cookbook apply` (`cli/agents/kitchen.md`).
