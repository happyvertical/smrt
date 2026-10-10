# @happyvertical/smrt-preferences

Saved user-interface preferences for s-m-r-t apps: how a page or the app
frame is arranged. An organization sets the default; each person can keep
their own version on top of it. Reset returns either one to the layer below.

Two kinds of preference ship with the package:

- **`overview`**: the layout of a customizable overview page from
  [`smrt-svelte/overview`](../smrt-svelte/agents/overview-surfaces.md)
  (which widgets, in what order, how wide, with which options).
- **`shell-layout`**: the app frame's settings from the AdminShell
  (navigation order and visibility, panel states and widths, keyboard
  shortcuts).

An app can register more kinds. Every kind checks its own data when it is
saved (anything invalid is refused) and again when it is loaded (anything
that no longer fits is dropped and reported, the rest still applies).

Use the stores below; the table's model is not an application API (it
refuses writes that do not come from the store and never returns another
person's preferences).

See [AGENTS.md](./AGENTS.md) for the storage rules and
[agents/preference-kinds.md](./agents/preference-kinds.md) for the kind
contract.

## Installation

```bash
pnpm add @happyvertical/smrt-preferences
```

Preferences live in the `_smrt_ui_preferences` table. Create it with your
normal migration (`smrt db:migrate`); the package never creates tables at
runtime. `smrt db:status --parity` reports it like any other table.

## Permissions

| Permission | Lets a person |
| --- | --- |
| `overviews.customize` | Change or reset the organization's default layout of a page |
| `overviews.personalize` | Keep and reset their own layout of a page |
| `shell.customize` | Change or reset the organization's default app frame |
| `shell.personalize` | Keep and reset their own app frame settings |

Owners and admins receive all four when role permissions are seeded. Members
and viewers receive the two `personalize` permissions; for roles created
before this package was installed, run
`seedDefaultRolePersonalizationPermissions()` from `@happyvertical/smrt-users`
once.

## Overview pages

```ts
// +page.server.ts
import { createOverviewStore } from '@happyvertical/smrt-preferences';
import { eventsHome, widgets } from '$lib/overviews';

export const load = async ({ locals }) => {
  const overviews = createOverviewStore({ db: locals.db });
  // Runs inside the request's tenant context; each widget loader receives
  // the capabilities passed here and must authorize through them.
  const overview = await overviews.loadPage(eventsHome, widgets, {
    locale: locals.locale,
    db: locals.db,
  });
  return { overview };
};
```

Save with the revision the page loaded; a stale revision returns `conflict`
instead of overwriting someone else's change:

```ts
const saved = await overviews.save(eventsHome, widgets, {
  scope: 'user',
  override,
  revision,
});
// saved.ok, or saved.reason: 'invalid' (with issues), 'conflict', 'not_allowed'
await overviews.reset(eventsHome, { scope: 'user', revision });
const result = await overviews.loadWidget(eventsHome, widgets, widget, ctx);
```

## App frame (shell layout)

```ts
import {
  createPreferenceStore,
  createShellSettingsPreferences,
} from '@happyvertical/smrt-preferences';

const shell = createShellSettingsPreferences(createPreferenceStore({ db }));

// Remote functions the browser's ShellSettingsAdapter calls.
export const readShellSettings = async () => (await shell.read('admin')).delta;
export const writeShellSettings = (delta: unknown) =>
  shell.write('admin', delta);
```

`read` merges the organization default with the person's own settings.
`write` without a revision writes over the latest stored value, because the
shell's adapter does not carry one; pass `{ revision }` to guard it.

## Other kinds

```ts
import {
  createPreferenceStore,
  registerPreferenceKind,
} from '@happyvertical/smrt-preferences';

registerPreferenceKind({
  kind: 'board-columns',
  formatVersion: 1,
  permissions: { tenant: 'boards.customize', user: 'boards.personalize' },
  validate: (payload, ctx) => checkColumns(payload, ctx),
});

const preferences = createPreferenceStore({ db });
const state = await preferences.load('board-columns', 'projects.board');
await preferences.save('board-columns', 'projects.board', {
  scope: 'user',
  payload,
  revision: state.user?.revision ?? null,
});
```
