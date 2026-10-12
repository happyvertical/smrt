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

## Cascade layers

Every component `<style>` block declares and uses the smrt layers, lowest to
highest: `smrt.reset < smrt.structure < smrt.theme`. Rules sit in
`@layer smrt.theme { … }` today. Unlayered consumer CSS always beats every smrt
layer, so restyling needs no `:global()` and no `!important`. The declaration is
[`src/styles/layers.css`](../src/styles/layers.css)
(`@happyvertical/smrt-ui/styles/layers.css`), injected by `ThemeProvider`. Keep
the order exactly as written.

## Restyling a component

Consumers depend on three public things only: **token names** (`--smrt-*`),
**layer names** (`smrt.reset`, `smrt.structure`, `smrt.theme`), and the
**`data-smrt-*` hooks** above. To restyle:

1. Change a token (`--smrt-color-primary`, `--smrt-radius-md`) for theme-wide
   changes.
2. Target a root or part from unlayered CSS for one-off changes:
   `[data-smrt-component="Card"]`, `[data-smrt-component="Modal"] [data-smrt-part="header"]`.
3. Use your own classes on your own elements.

Do not reach into hashed Svelte classes (`.svelte-1x2y3z`); they change on every
build.

## Styleless mode (`unstyled.css`)

Import one stylesheet to strip the look from every smrt component while keeping
its layout:

```ts
import '@happyvertical/smrt-ui/styles/unstyled.css';
```

- **Kept (layout):** `display`, flex/grid, `gap`, `padding`, `position`, sizing,
  and everything else not in the list below. Shells, editors, and chat threads
  depend on this layout CSS.
- **Reverted (look):** `background`, `border`, `border-radius`, `box-shadow`,
  `color`, `font`, `letter-spacing`, `text-decoration`, `text-transform`,
  `text-shadow`, `outline`, `filter`, `backdrop-filter`. Each one falls back to
  `smrt.structure`, then to the browser default.
- **Reset:** buttons, inputs, selects, and textareas inside component trees get
  `margin`, `padding`, `border`, `background`, `color`, and `font` reset, so a
  stripped control does not show UA chrome such as the 2px outset border.
- **Specificity:** the revert selector carries three `:not(#\#)` boosts (specificity
  `(3,1,0)`), which beats Svelte's hashed `.svelte-*` selectors without
  `!important`.
- **Consumer CSS wins:** unlayered rules override the revert. Style stripped
  components with unlayered CSS, `--smrt-*` tokens, or the hooks above.

The reverted list is explicit on purpose. `all: revert-layer` would also drop
layout declarations until per-package structure/theme sorting lands, because
every component rule currently sits in `smrt.theme`. When that sorting lands,
layout moves to `smrt.structure` and the list can be widened to `all`.

Component `transition` declarations still run, so a stripped Card or Button
fades to its unstyled colours over its usual duration.

Verification: the jsdom contract test
(`src/themes/__tests__/unstyled-css.test.ts`) asserts the declared rule and its
targets. Computed-value reversal is asserted in Chromium by
`e2e/styleless.spec.ts`. The playground entry `styleless-mode` toggles the
stylesheet across the catalogue.
