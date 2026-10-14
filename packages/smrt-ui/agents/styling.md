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
  `NO_ROOT_ELEMENT` in `scripts/component-roots.mjs` with a reason. Elements
  passed as slot or children content to a root-level child component are never
  roots: they carry no hook of the wrapper's name. The one exception is a
  transparent provider that renders only its children and no element (the `SLOT`
  entries in `NO_ROOT_ELEMENT`, for example `FieldPolicyProvider`): its slot
  content is rendered directly at the caller's root and keeps the hook.

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
- The wave-2 pilot also exposes Chip `body`/`close`; Alert `marker`/`body`/`title`/`message`/`actions`/`close`; Checkbox `input`/`box`/`indicator`/`label`; Switch `input`/`control`/`track`/`thumb`/`label`; and Tabs `row`/`overflow`/`body`/`indicator`/`marker`/`description`. Checkbox reuses `indicator` for the check and indeterminate dash. Badge, Input and Select have no owned internal parts. Other packages add parts incrementally under the same rules.

## Cascade layers

Every component `<style>` block declares and uses the smrt layers, lowest to
highest: `smrt.reset < smrt.structure < smrt.theme`. Button, Badge, Chip, Card, Alert, Input, Select, Checkbox, Switch and Tabs
split their rules between `smrt.structure` and `smrt.theme`; other components
still put their rules in `smrt.theme`. Unlayered consumer CSS always beats every smrt
layer, so restyling needs no `:global()` and no `!important`. The declaration is
[`src/styles/layers.css`](../src/styles/layers.css)
(`@happyvertical/smrt-ui/styles/layers.css`), injected by `ThemeProvider`. Keep
the order exactly as written.

### Host resets (universal reset, Tailwind preflight, normalize)

An unlayered universal reset (`*, *::before, *::after { margin: 0; padding: 0 }`,
Tailwind preflight, normalize.css, sanitize.css) beats every smrt layer and strips
padding from every component. Put the reset in a layer that sorts before
`smrt.theme`:

- **(a) Plain reset:** wrap it in the reset layer.

  ```css
  @layer smrt.reset {
    *, *::before, *::after { margin: 0; padding: 0; }
  }
  ```

- **(b) normalize.css:** import it into the reset layer.

  ```css
  @import url("normalize.css/normalize.css") layer(smrt.reset);
  ```

- **(c) Tailwind v4 preflight:** preflight already sits in `@layer base`. Declare
  the full order before any import: `base` sorts before the smrt layers, and
  `components` and `utilities` sort after them so utility classes still override
  smrt:

  ```css
  @layer theme, base, smrt.reset, smrt.structure, smrt.theme, components, utilities;
  @import "tailwindcss";
  ```

Layer order is set by first appearance. If `base` first appears after
`smrt.theme`, it sorts above smrt and preflight wins: in Chromium,
`@layer smrt.reset, smrt.structure, smrt.theme; @layer base { * { padding: 0 } }
@layer smrt.theme { .c { padding: 16px } }` computes `padding: 0`. Shortcut: import
`@happyvertical/smrt-ui/themes/styles/base.css`, which already ships its reset in
`smrt.reset`.

Run `smrt doctor` to flag unlayered resets in a project that depends on smrt-ui.

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

## Copy

User-facing copy in components follows three rules:

- Sentence case ("Close menu", not "Close Menu").
- No developer region names. "Left sidebar", "Right sidebar", "Header" and
  "Footer" name regions in the layout editor and settings only; everywhere else
  say what the control does ("Menu", "Tools", "Collapse sidebar").
- Strings come from the i18n message tables (for example
  `smrt-svelte/src/i18n/strings.workspace.ts`), never hardcoded in markup.

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
layout declarations until per-package structure/theme sorting lands, in components that have not been sorted yet. The ten pilot primitives retain
their layout with `all`, but a pilot root can contain an unsorted component in
a snippet. The Chromium regression demonstrates that the candidate reset strips
that nested component's layout. Keep the production list until the entire
reachable subtree is sorted; the playground's **Try all: revert-layer** toggle
exercises the candidate on the ten pilot subtrees, including pseudo-elements.

With the production explicit list, component `transition` declarations still run, so a stripped Card or Button
fades to its unstyled colours over its usual duration.

Verification: the jsdom contract test
(`src/themes/__tests__/unstyled-css.test.ts`) asserts the declared rule and its
targets. Computed-value reversal is asserted in Chromium by
`e2e/styleless.spec.ts`. The playground entry `styleless-mode` toggles the
stylesheet across the catalogue.

Shell motion (track transitions, list flips, view transitions, theme crossfade) and its reduced-motion behaviour: see the Motion section of `packages/smrt-svelte/agents/workspace.md`.

## Premium baseline token vocabulary

See the table in [src/themes/README.md](../src/themes/README.md#premium-baseline-token-vocabulary): surface ladder, hairlines, state layers, shadow colour, control geometry, focus ring, native chrome, glass and motion/typography tokens. Themes define them; components consume them and use a component-prefixed name that falls back to the theme token for per-variant overrides, because the required-tokens scanner drops any name a component defines on its own root.

## Typography

Headings, role utilities (`.smrt-display-large` ... `.smrt-label-small`) and tabular figures live in `base.css`; see [Typography](../src/themes/README.md#typography).

## ThemeProvider runtime features

Built-in presets stay static (no inline token payload); only user overrides go inline: non-`md` `borderRadius` (control radius tokens), `primaryColor` (derived set via `derivePrimaryOverrides`) and `density`. `data-smrt-theme-changing` marks one `--smrt-duration-scheme` after a post-mount scheme change (not on first paint, not under reduced motion); `data-contrast` (`standard|more|forced`) and `data-forced-colors` come from `prefers-contrast`/`forced-colors` or the `contrast` prop. `themeScript()` stamps `data-contrast`/`data-density` pre-paint from the same persisted config; keep it tiny. Forced-colors contract: hairlines `CanvasText`, focus rings `Highlight`, no painting over system colours.

## Forced colors

Contract and token table: [Forced colors](../src/themes/README.md#forced-colors).

- The token layer (hairlines `CanvasText`, focus ring `Highlight` 3px, inert elevations,
  no glass blur, `Canvas` glass and scrim, zeroed state layers) lives in `base.css`,
  **unlayered** (preset token blocks are unlayered, so only an unlayered rule beats them),
  and as `FORCED_COLORS_TOKENS` for `ThemeProvider`. Components never redeclare those
  tokens; they consume them.
- A component adds a `@media (forced-colors: active)` block inside its `smrt.theme` layer
  only where colour alone carries meaning (selected, checked, pressed, open, disabled),
  using system colours: `Canvas`, `CanvasText`, `Highlight`, `HighlightText`, `GrayText`.
  Paint a non-colour cue too (indicator bar, outline, bold text). Do not use `opacity` to
  express disabled; use `GrayText`.
- If a rule sets `outline` for selection, scope it `:not(:focus-visible)` so it never
  replaces the focus ring.
- Keep `forced-color-adjust: auto`. The only valid reason for `none` is an element whose
  author colour is the content (colour picker, swatch); say why in a comment.
- Test with `page.emulateMedia({ forcedColors: 'active' })` and assert computed values
  (`border-color` resolves to a system colour, no visible `box-shadow`, `backdrop-filter`
  blur 0, focus ring `Highlight` and at least 2px).


Use `--smrt-hairline` / `--smrt-hairline-strong` for quiet / strong edges, `--smrt-hairline-color` / `--smrt-hairline-strong-color` for edge colours and matching `--smrt-inset-highlight` shadows (transparent when neutral, never `none` in shadow lists); run `node scripts/codemod-smrt-hairlines.mjs` to convert supported literals and list exceptions, and spell concrete token names in markdown because `scripts/check-svelte-tokens.mjs` scans docs under `src`.

## Visual regression

Before accepting a styling change, run the playground preset screenshot matrix.
The [playground visual-regression guide](../../smrt-playground/AGENTS.md#visual-regression-styling-wave-2)
defines the pinned Linux renderer, baseline update/review flow and required
`Playground Visual Regression` CI job. Baseline changes must represent intentional
visual changes; a structure/theme split should leave them unchanged.

## Structure/theme pilot classification (#3881)

Preserve declaration order within each layer, splitting mixed rules without
changing selector specificity or Svelte scoping. Keep media queries in each
applicable layer; put animation keyframes with their animation in theme.

- **Structure:** display, flex/grid, gap, padding/margin, position/insets,
  dimensions, overflow, clipping, visibility, hit-area geometry, interaction
  cursor/pointer behavior, and text truncation/wrapping. Hidden native inputs
  and loading labels retain their hiding opacity. Switch thumb translation and
  scale are structural: they express checked position and control geometry.
- **Theme:** colors, backgrounds, borders (including width), radii, shadows,
  typography, decorative opacity, outlines, filters, transitions and animations.
  Card hover lift is decorative. Removing borders/typography can change measured
  outer geometry in styleless mode; structural declarations remain intact.
- Classify custom properties by their consumers. Density overrides belong to
  structure and use component-private names (`--smrt-button-target-min`,
  `--smrt-input-target-min`, `--smrt-select-target-min`,
  `--smrt-checkbox-target-min`, `--smrt-switch-target-min`), falling back to the
  inherited `--smrt-control-target-min`. Do not redeclare shared theme tokens.
  `--smrt-control-hit-size` is an optional host override, not a preset token;
  its existing 2.75rem fallback remains necessary.
- Namespace **all** owned classes, including root, size, variant and state
  modifiers, as `smrt-<component>__<part-or-modifier>`. Consumer classes passed
  through props remain untouched. Use role-based part attributes in consumer
  CSS and tests; keep state on existing native/ARIA attributes.
- Keep the explicit reset during incremental rollout. A root allowlist alone
  cannot protect an unsorted nested component. `all` also needs pseudo-element
  coverage; keep transparent hit targets in structure so they survive it.

The Styleless Mode fixture now includes all ten primitives. Its second checkbox
is experimental and only takes effect while **Apply unstyled.css** is enabled.
The candidate strips transition and decorative opacity too; production retains
its prior behavior. Pixel baselines for the original fixture establish that the
split itself does not change rendering; fixture additions are reviewed separately.

## Sorting a wave-3 slice

Preview only the assigned files, then write the same selection:

```sh
node scripts/codemod-smrt-sort-layers.mjs --check --file packages/smrt-ui/src/components/ui/Avatar.svelte --report /tmp/avatar-sort.json
node scripts/codemod-smrt-sort-layers.mjs --write --file packages/smrt-ui/src/components/ui/Avatar.svelte --report /tmp/avatar-sort.json
```

Repeat `--file` for a slice, or use `--package smrt-ui` only when the whole package
is assigned. A selection is required; no arguments never rewrites the repository.
`--check` (also the default) is read-only and exits 1 for pending changes or TODOs.
`--write` exits 1 when TODOs remain, even after writing the mechanical split.
A second run leaves the output unchanged and reports the remaining TODO markers.
Already sorted files are not reclassified.

The codemod puts `display`, `flex`, `grid-template-columns`, `gap`, `padding`,
`margin`, `width`, `height`, `position`, `inset`, `overflow`, `clip`, `white-space`,
`text-overflow`, and `cursor` in `smrt.structure`. It puts `color`, `background`,
`border` (including `border-width`), `border-radius`, `box-shadow`, `font-size`,
`outline`, `filter`, `transition`, and `animation` in `smrt.theme`. Selectors,
`:global()`, conditional wrappers, and declaration order within each layer are
preserved; keyframes stay intact in theme with animation, including declarations
such as `transform` inside them. Forced-colors paint stays in theme.

The JSON report contains each file's TODO line, selector/wrapper path, declaration,
and reason. `opacity`, `transform`, `transform-origin`, `visibility`, `content`,
and `pointer-events` need role review; the codemod conservatively reports all
`pointer-events`, including hit areas. Custom properties such as
`--smrt-checkbox-hit` need consumer review. Unknown properties, unsupported
wrappers and parse failures are reported rather than guessed. Unresolved CSS
stays in its original theme layer with a `smrt-sort-todo:` comment; parse failures
leave the entire file unchanged. Move each declaration to its reviewed layer and
remove its marker only after deciding it. The gate rejects unresolved markers.
The codemod does not rename classes, add parts, remove token fallbacks, or invent
forced-colors rules. Complete those judgment steps under the pilot rules above.

`node scripts/check-smrt-sort-layers.mjs` runs inside root `pnpm lint`. Once a
component uses a `smrt.structure` block, layout in theme or paint in structure
fails. `opacity`, `transform`, `visibility`, and `content` are allowed in either;
keyframe declarations are exempt from ordinary property placement checks.
The checked-in `scripts/smrt-sort-ratchet.json` records unsorted files and distinct
un-namespaced owned class names per file (local CSS selectors, static native-element
class attributes and class directives; repeated selectors count once, and
`:global()` classes and classes passed to child components do not count).
Dynamic class expressions are covered where they have local CSS selectors; this
inventory does not prove all runtime-generated class names are namespaced.
After completing and namespacing a slice, run
`node scripts/check-smrt-sort-layers.mjs --write`. Stale entries fail lint;
`--write` accepts shrinking debt but refuses increased counts or a sorted/new
file becoming unsorted. An empty `smrt.structure` block explicitly marks a
paint-only component as sorted. The existing cascade-layer gate still enforces
layer ownership and order.

Reproduce the ten-primitive experiment with
`node scripts/compare-smrt-sort-pilot.mjs --report /tmp/smrt-sort-pilot.json`.
It reads pre-pilot sources from `716e55114`, writes temporary before/after files,
and compares declarations against the working-tree pilots using
`scripts/smrt-sort-pilot-map.json`. It reports exact-value matches, value changes,
wrong-layer placements, TODOs and hand-only additions separately, without sorting
any repository component. Value differences from removed token fallbacks or
private density overrides remain visible in the generated PR table and details.
