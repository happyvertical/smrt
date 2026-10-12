# Styling hooks: roots and parts

Consumers may depend on three public things: token names, cascade-layer names,
and `data-smrt-*` hooks. This file defines the hooks. Renaming any of them is a
breaking change, so follow these rules rather than improvising names.

## Root hook: `data-smrt-component`

- Every exported component renders `data-smrt-component="<Name>"` on its root
  element(s).
- `<Name>` is the exported component's file basename in PascalCase
  (`Button`, `Tabs`, `DataTable`). Do not add a package prefix.
- A component with several root elements (for example `{#if}` branches) puts
  the hook on each of them.
- Placement is after the element's attributes. A consumer-supplied
  `data-smrt-component` passed through `{...rest}` is overridden by the
  component's own value, so the hook always identifies the component.
- Components whose template is only a child component (a wrapper) do not own a
  root element. Their rendered root carries the child's hook. They are listed in
  `NO_ROOT_ELEMENT` in `scripts/component-roots.mjs` with a reason.

The gate is `pnpm check:component-roots` (part of `pnpm lint`). It fails when an
exported component's root lacks its hook. Add the hook when you add a component;
the codemod `node scripts/component-roots.mjs --write` is idempotent.

## Part hook: `data-smrt-part`

- Put `data-smrt-part="<kebab-name>"` on an internal element a consumer or test
  may need to target. Parts are added where useful, not on every element.
- Name the part by its **role**, not its appearance: `header`, `body`,
  `footer`, `label`, `trigger`, `panel`, `list`, `tab`, `close`.
- Reuse the same role name across components. A `label` is a `label` in
  Button, Tabs, and Badge alike.
- **Never encode state in a part name.** Not `active-tab`, `disabled-button`,
  `open-panel`. State belongs on ARIA attributes (`aria-selected`,
  `aria-expanded`, `aria-disabled`, `aria-current`) or, where no ARIA state
  exists, `data-smrt-state` (reserved; no primitive emits it yet).
- Part names are public API. Adding a part is cheap; renaming one is breaking.

Parts are scoped to their component root. Use `getByPart(component, part)` from
`@happyvertical/smrt-vitest/svelte` in tests:

```ts
import { getByPart, queryByPart } from '@happyvertical/smrt-vitest/svelte';

const tab = getByPart('Tabs', 'tab', container); // throws if 0 or >1 match
const badge = queryByPart('Tabs', 'badge', container); // null when absent
```

## Worked example: smrt-ui primitives

| Component (file)          | Root hook | Parts                                                                 |
| ------------------------- | --------- | --------------------------------------------------------------------- |
| Button (`ui/Button`)      | `Button`  | `spinner` (loading glyph), `label` (content wrapper)                  |
| Card (`ui/Card`)          | `Card`    | `header`, `body`, `footer`                                            |
| Dialog (`feedback/Modal`) | `Modal`   | `header`, `title`, `close`, `body`, `footer`                          |
| Tabs (`nav/Tabs`)         | `Tabs`    | `list`, `tab`, `label`, `count`, `badge`, `panel`, `trigger`, `menu`  |
| Input (`forms/Input`)     | `Input`   | none: the root `<input>` is the only element                          |
| Select (`forms/Select`)   | `Select`  | none: the root `<select>` is the only element                         |
| Badge (`ui/Badge`)        | `Badge`   | none: the root `<span>` is the only element                           |

Notes:

- There is no component named `Dialog` in smrt-ui. The dialog primitive is
  `Modal`, and the root hook keeps its real name.
- `Tabs` uses `tab` for both the tablist button and the link-mode anchor,
  `list` for the tablist and the link-mode nav, and `trigger` for the overflow
  `<summary>`.
- Parts shown here are the first wave. Other packages add parts incrementally
  under the same rules.
