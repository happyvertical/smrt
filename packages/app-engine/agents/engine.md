# Shared app engine (`src/`)

Runs a person's own smrt app from a versioned JSON definition. The host
(`AppHost`) owns the version history (through a `VersionStore`) and the data
directory; the app itself runs in a worker thread with its own registry and
`app.db`. Every definition change starts a fresh worker (the registry only
adds) and swaps it in once it is ready. The engine must not import SvelteKit,
`$lib`, or anything under `src/lib`.

## Rules

- **Approval gate.** `RISKY_COMMANDS`, `isRiskyCommand` and `isRiskyTool` live
  in `commands.ts`. `execute` throws `ApprovalRequiredError` for a risky
  command without `approved: true`; `callAppTool` does the same for
  `<model>_delete`, and `rest` for `DELETE`. Approval covers the command, not a
  plan hash: the plan is recomputed at execute time.
- **Queue.** Work inside the change queue must call `callApp`, never `onApp`
  (which awaits the queue): the old `clean_up` deadlock.
- **Migrations** (`app-runtime.ts`) run in one transaction in the new worker,
  reading through the transaction handle. Destructive ones retire the old worker
  first and restart the old definition if the new one fails. They are
  SQLite-shaped (`RENAME/DROP COLUMN`, `VACUUM INTO`, `pragma_table_info`);
  Postgres is future work.
- **Column storage.** No column-type history: re-adding a field checks the real
  column's storage family. Text defaults can be `''`, so counts and archives use
  `IS NOT NULL AND <> ''`. Renames do not rewrite method code; the plan lists
  `affectedMethods`.
- **App subclass rule.** `enableRecipe('profiles')` adds the app model
  `Profile` (`extends` the shipped class). Its fields are nullable columns on
  the shipped `profiles` table (STI). Never subclass `ProfileType` (its
  subclass would get its own table). Creating a Profile find-or-creates the real
  `person` `ProfileType`.
- **Sandbox** (`sandbox.ts`): QuickJS, pure function over a copy of the data.
  Everything crossing the boundary is JSON text. Limits: time, memory, a small
  stack (128 KB), 1000 writes, 1 MB output, 8 MB input. The body is checked as a
  function body by V8 first (QuickJS's own `Function` accepts a body that closes
  the wrapper). Writes are validated and a `VACUUM INTO` snapshot is taken before
  they are applied.
  `setMemoryLimit` does not bound large single allocations in this build, and the
  interrupt handler is polled only every ~10,000 operations, so the WebAssembly
  heap itself is capped (`SANDBOX_HEAP_PAGES`, 128 MB): a memory bomb stops in
  ~0.2 s instead of allocating 2 GB.

## Profile subclass (core gap fixed, #4871)

The app subclass of the shipped `Profile` is registered as
`@local/app:Profile`, the same class name as its parent. Core keeps the two
apart: `registerRuntimeModel` leaves a same-named parent registered (constructor
index, no lineage replacement), and the parent's generated REST and MCP
surfaces are closed with `ObjectRegistry.registerOverride(parent, { api: false,
mcp: false })` in `AppRuntime.register`, so only the subclass's tools exist.
Covered by core's `runtime-model.test.ts` and engine `profile-subclass.test.ts`.

## Safety rules added in review

- **Undo is gated when it overwrites data.** `undo` is not in `RISKY_COMMANDS`;
  the host decides from the *stored* version (`analyseUndo`): a version with a
  `convertColumn` step restores each row's archived original on the way back,
  replacing values written since, so the plan is `risky` with a read-only
  `countOverwrites` preview (`replaced`, `fields[]`). Every other undo stays
  immediate. The shell pins the approval to that version (`undo.version`); the
  host refuses if the app moved on.
- **REST surface.** `restRouteAllowed` (definition.ts) lets only
  `/api/<route>` and `/api/<route>/<id|action>` of the app's own models through,
  in `AppHost.rest` and `AppRuntime.rest`. Core's reserved `sync/apply` (its
  `delete` op deletes records), `_changes`/`_events`/`_inference` and the
  registry fallback to shipped classes (e.g. `ProfileType`) are 404 before the
  DELETE gate. `DELETE` on an allowed route still needs approval.
- **Snapshot retention** (`snapshots.ts`): the worker keeps the newest 20
  `method-*` snapshots after each new one; `cleanUp` removes `migrate-*` and
  `schema-*` snapshots older than the newest change it purges. Only plain files
  matching the engine's own name pattern in `snapshots/` are ever deleted
  (never symlinks, directories or other files).
- **importTemplate preview** lists every method (model, name, description,
  params, code), so what the owner approves is what is shown; a template with
  more than 200,000 characters of method code is refused as unreviewable.

## Drafts (draft then publish)

A draft is a second `AppHost` over a COPY of the live data in its own
directory; publishing replays its changes onto the live data. The engine side
is documented here; the shell's tables, approvals and UI sit on top.

- **Frozen host.** `HostOptions.frozen` / `host.setFrozen(bool)`: `plan` and
  `execute` of every command in `STRUCTURAL_COMMANDS` (all but
  `exportTemplate`, incl. `undo`, `cleanUp`, `importTemplate`) throw
  `EngineError('refused')`; an unknown command type counts as structural.
  `STRUCTURAL_COMMANDS` is a total `Record<CommandType, boolean>`, so a new
  command must pick a side. Records, reports, the app's tools and REST keep
  working. The shell freezes the live host while a draft is open.
- **`autoApprove`** (risky commands, `_delete` tools, REST `DELETE`) is read
  once at construction into a `#private` field: no setter. `AppHost.open`
  refuses it unless the directory holds the engine's draft marker
  (`.smrt-draft.json`, written only by `forkDraft`) naming a different live
  directory. A live directory never has a marker.
- **`live.forkDraft(draftDir, { store })`** (queue, calls drained): worker op
  `copyTo(path)` is `VACUUM INTO` (one consistent state, no -wal/-shm needed).
  The call creates `draftDir` (must not exist, must not be/contain/lie inside
  live), copies `app.db`, writes the marker, seeds the EMPTY draft store with
  a copy of live's current record (the draft's BASE, same version number; not
  a draft version) and returns a draft host (`host.draft` is the marker,
  `autoApprove` on). Failure removes only the directory it just created. A
  draft can neither fork nor `undo` below its base. Draft versions are
  numbered `maxVersion + 1` in the draft store. `draft.discard()` closes the
  host and deletes its directory, only if it holds the marker, is not a symlink
  and does not contain the live directory (`discardDraftDirectory(dir)` does the
  same for an orphan). A restart reopens a draft with
  `AppHost.open(dir, { store, autoApprove: true })`.
- **Publish** (`publish.ts` helpers, `host.ts` orchestration). `live.previewPublish(draft)`
  returns a `PublishPreview`: per-version steps and SQL, definition diff, archive
  counts and EVERY method in full, from a rehearsal on a fresh copy of the CURRENT
  live data (live only waits while the copy is taken); `digest` pins the draft's
  chain. `live.publishDraft(draft, { author, approved: true, expect: digest, draftName? })`
  refuses without `approved`, without the digest, if the chain or the app it
  started from changed, or if a `.prepublish` file is lying around. Inside the
  queue, calls drained: copy live, replay each draft version in order (one short
  worker per version, its stored definition and steps, the number it will get in
  live; so add-then-rename works), write the result as ONE file (`VACUUM INTO`),
  copy the old data to `snapshots/<ts>-0-migrate-prepublish.db`, write
  `publish-journal.json`, retire the live worker, rename `app.db` (+ `-wal`,
  `-shm`, `-journal`; main file last) to `<name>.prepublish`, rename the new file
  in, start the worker, write the versions to the store, then remove journal,
  asides and rehearsal. The versions are N ordinary live versions numbered after
  the store's HIGHEST (live may sit on an undone branch), parent-chained,
  summaries tagged `[draft: name] ...`; archives are keyed by those numbers so
  `undo` works. Draft records are not carried. Any failure before the store is
  written renames the asides back (live's `app.db` is byte-for-byte what it
  was, same version) and restarts the old app; `onStage` lets tests fail each
  stage. Use a store with the optional atomic `commit(records, current)`; without
  it a failure mid-append leaves unreachable orphan versions. The queue is held
  until then, so nothing writes to the new file before the commit.
- **Boot reconcile** (`reconcilePublish`, every `AppHost.open`, before the app
  starts; result in `host.recovery`): a journal whose `finalVersion` is the
  store's current only needs its leftovers removed; any other journal is ROLLED
  BACK (asides restored, the new file removed), not forward: nothing could have
  written to the new file, and the draft stays open to publish again. An
  unreadable journal refuses to start rather than guess. Stray
  `publish-rehearsal-*` directories are removed.
- **`undoTo`** is a command (`{ type: 'undoTo', version, from? }`, structural, so
  frozen hosts refuse it): the same step as `undo` repeated newest first for
  every version after `version` on the current path, one plan, one decision.
  It is `risky` (approval) when any of them has a `convertColumn` step, with the
  summed `countOverwrites` preview; a purged version in the span refuses it
  before anything changes. Each step is its own consistent state, so a failure
  part-way leaves the app at the version reached and the error says
  "undid k of n". `from` pins the current version as `undo`'s pin does.
- **Undo over a re-added name.** Undoing an add or a define keeps its column or
  table (data is never dropped by an undo). So when a removal is undone after
  the same field or model was added again, the archived values go back into the
  column that is there, and an EMPTY table of the model's name is dropped so the
  archived table (with its rows) can return; a table holding rows is never
  dropped and the undo stops with the database's own message.
- **Queued calls.** `onApp` (records, tools, REST) waits until the change queue
  is idle and stable, then runs in the same synchronous step; it counts
  in-flight calls so a change can wait for them (needed for consistent copies).

## Lessons

- A worker must not be terminated while `@happyvertical/sql`'s startup HMAC key
  job is pending (Node aborts the process); `app-worker.ts` settles it before
  reporting ready.
- If V8 overflows its own stack inside WebAssembly, QuickJS cannot recover; the
  small QuickJS stack limit keeps its error first, and a host-level failure
  discards the WASM module instance.
