# smrt-svelte/command-palette

Module semantics for `src/components/command-palette/` (`./command-palette`).
Package orientation and cross-module invariants live in
[../AGENTS.md](../AGENTS.md); the shell it sits in is in
[workspace.md](workspace.md).

## Shape

- **Controller** (`controller.svelte.ts`): `createCommandPalette({ providers,
  navigate, onError, searchDebounceMs, maxPerGroup })`. Owns open/query state,
  the provider registry, local and remote rows, the highlight, and `activate`.
  `setCommandPalette(controller)` puts it on context (call it above the
  `AppShell`) so any descendant can `useCommandPaletteProvider(provider)`; that
  hook is a no-op without a palette.
- **Components**: `CommandPalette` = `CommandPaletteTrigger` + `CommandPaletteDialog`.
  Mount it **once**: the dialog owns the global shortcut (`hotkeys`, default
  `['Mod+K']`; `false` for none). Place it with `AppShell` `slotItems`
  (`header.center` is the usual slot); it is a movable item like any other.
  Without a `palette` prop or context it builds one from `providers`/`navigate`.
- **Pure core**: `match.ts` (accent/case-insensitive, multi-term, word-start
  then in-order fuzzy; returns title ranges), `rank.ts` (groups, limits,
  boost), `hotkeys.ts` (`Mod` = Ctrl or Meta). Node-testable, no Svelte.

## Provider contract (`types.ts`)

A `PaletteProvider` is `{ id, label, order?, items?, search?, minQueryLength?,
limit? }`.

- `items(ctx)` rows are re-read **every time the palette opens** and matched
  locally by the palette. Sync results land in the same tick; async ones fill
  in (`busy`).
- `search(query, { signal, limit })` runs after the debounce with an abort
  signal that fires on the next keystroke or close. Its rows are shown as
  returned (not re-filtered); earlier rows stay until the new ones arrive. A
  superseded result is dropped, never shown.
- Registering an id again replaces the provider; a stale disposer is a no-op.
- Authorization stays with the provider. A failing provider is reported through
  `onError` (default: logger warning) and marked in `failedProviders`; the
  palette keeps working. The palette is not a security boundary.
- A row with `run` runs; else a row with `href` goes through `navigate`
  (default `window.location.assign`; SvelteKit apps pass `goto`). The palette
  closes first, then runs.

## Shipped providers (`providers.ts`)

- `createNavigationProvider({ nav, groups })`: rows for the shell nav. Pass
  getters over `useShellLayout().applied` to honor sections a user hid.
- `createModelProviders({ manifest, ... })` returns `[commands, records]`:
  - eligibility is `navigableManifestEntries` (exported from
    `workspace/manifest-nav.ts`), so it agrees with manifest-derived nav;
  - commands: "New <noun>" for models whose REST `create` route exists;
    destinations come from `hrefs` or the `<pagesBasePath>/<collection>[/new|/id]`
    convention (the app owns its page routes);
  - records: `GET <apiBasePath>/<collection>?<field>[like]=%q%` per model, one
    text field each (first of `title`, `name`, `displayName`, ... that is a
    non-sensitive, non-enum text field; override with `searchFields`), capped by
    `maxModels` and `concurrency`, interleaved so one model cannot crowd out
    the rest. 401/403/404 mean "no results" for that model; the search throws
    only when **every** request fails.
  - Known limit: `LIKE` is case-insensitive on SQLite and case-sensitive on
    PostgreSQL (sdk#1192). Supply `searchRows` to use a server search endpoint
    instead.

## Accessibility and keyboard

WAI-ARIA combobox: focus stays in the search box; `aria-activedescendant`
names the highlighted option; options sit in labelled groups inside a
`listbox`; a polite status region announces counts and "no results". Up/Down
(wrapping, skipping disabled rows), PageUp/PageDown, Enter, Escape (the
`Modal` closes). Disabled rows stay visible with their reason as the tooltip.
A bare-key shortcut (`/`) never fires while typing in a field or during IME
composition; a modified one (`Mod+K`) does. Strings are in
`src/i18n/strings.palette.ts` (registered in `i18n/server.ts`); provider group
labels default to English and are options on the shipped providers.

## Not yet wired

Recipe surfaces (#3708): a recipe will declare the palette as a shell widget
and its own providers (for example an assistant provider) once non-model
surfaces exist. Until then hosts mount `CommandPalette` themselves.
