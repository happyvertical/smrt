# @happyvertical/smrt-overviews

Saved layouts for the customizable overview pages of
[`smrt-svelte/overview`](../smrt-svelte/agents/overview-surfaces.md). An
organization sets the default layout of a page; each person can then keep
their own version on top of it. Reset returns either one to the layout below.

- **Three layers.** The page's built-in defaults, then the organization's
  default, then the person's own layout. A person's layout records only what
  they changed, so later changes to the organization default still reach them.
- **Validated twice.** A layout is checked against the page's allowed widgets
  and each widget's options when it is saved (anything invalid is refused) and
  again when it is loaded (anything that no longer fits is dropped and
  reported, the rest still shows).
- **Server-side data.** The page's server load runs every widget's loader with
  the signed-in person's permissions, so the page renders complete on first
  paint.

See [AGENTS.md](./AGENTS.md) for the storage rules and invariants.

## Installation

```bash
pnpm add @happyvertical/smrt-overviews
```

The layouts live in the `_smrt_overview_overrides` table. Create it with your
normal migration (`smrt db:migrate`); the package never creates tables at
runtime. `smrt db:status --parity` reports it like any other table.

## Permissions

| Permission | Lets a person |
| --- | --- |
| `overviews.customize` | Change or reset the organization's default layout of a page |
| `overviews.personalize` | Keep and reset their own layout of a page |

Owners and admins receive both when role permissions are seeded. Members and
viewers receive `overviews.personalize`; for roles created before this
package was installed, run `seedDefaultRolePersonalizationPermissions()` from
`@happyvertical/smrt-users` once.

## Load a page

```ts
// +page.server.ts
import { createOverviewStore } from '@happyvertical/smrt-overviews';
import { eventsHome, widgets } from '$lib/overviews';

export const load = async ({ locals }) => {
  const store = createOverviewStore({ db: locals.db });
  // Runs inside the request's tenant context; each widget loader receives
  // the capabilities passed here and must authorize through them.
  const overview = await store.loadPage(eventsHome, widgets, {
    locale: locals.locale,
    db: locals.db,
  });
  return { overview };
};
```

`overview` carries the rendered document (`loaded`), each layer's saved
layout and revision, any dropped entries (`issues`) and
`canCustomize: { tenant, user }`.

## Save, reset and add widgets

```ts
import { createOverviewStore } from '@happyvertical/smrt-overviews';

const store = createOverviewStore({ db });

// The person's own layout. `revision` is the one the page loaded.
const saved = await store.save(eventsHome, widgets, {
  scope: 'user',
  override,
  revision,
});
if (!saved.ok) {
  // 'invalid' (with issues), 'conflict' (reload and retry) or 'not_allowed'
}

await store.reset(eventsHome, { scope: 'user', revision });

// Data for a widget being added or reconfigured (the controller's loadWidget).
const result = await store.loadWidget(eventsHome, widgets, widget, ctx);
```

Wire these to the client controller from `smrt-svelte/overview`:
`createOverview({ definition, override, onchange, canCustomize, loaded,
loadWidget })`. For the personal layer, pass
`withTenantDefaults(definition, overview.tenant.document)` as the definition
and `overview.user.override` as the override; for the organization layer pass
the page definition and `overview.tenant.override`.
