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
The gate follows real TypeScript export statements (including direct `.svelte`
exports), ignores commented examples and rune `.svelte.ts` modules, and fails
if an exported component source is missing. Build generated sources before
running it; generated components obey the same root and layer contract.

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
- The wave-2 pilot also exposes Chip `body`/`close`; Alert `marker`/`body`/`title`/`message`/`actions`/`close`; Checkbox `input`/`control`/`indicator`/`label`; Switch `input`/`control`/`track`/`thumb`/`label`; and Tabs `row`/`overflow`/`body`/`indicator`/`marker`/`description`. Checkbox reuses `indicator` for the check and indeterminate dash. Badge, Input and Select have no owned internal parts. Other packages add parts incrementally under the same rules.

### smrt-ui part vocabulary (wave 3)

Use these names for the same roles throughout smrt-ui. Internal class names may
be more specific; public parts describe the role. Repeat a part for repeated
items or responsive alternatives, and scope it through its parent part or native
attributes when needed. A component root, including a conditional or sibling
root, carries only `data-smrt-component`, never `data-smrt-part`.

`body` replaces generic `content`/`details`; `header` replaces `heading`;
`description` replaces `hint`; `control` names the Checkbox/Radio mark shell.
Calendar event representations share `event`, and their children share `time`,
`title`, `body`, `meta`, and `label`. Responsive label lengths, required state,
and dictation state do not create new part names. `empty`, `error`, and `status`
name feedback regions; they do not replace native/ARIA state attributes.

| Part | Role | Examples |
| --- | --- | --- |
| `action` | An individual secondary command. | `CameraCapture`, `DocumentViewer` |
| `actions` | A group of commands or toolbar actions. | `Alert`, `CameraCapture` |
| `adornment` | Content attached before or after a field. | `InputGroup` |
| `author` | The author identity of a message. | `MessageBubble` |
| `axis` | Chart category-axis labels. | `Chart` |
| `back` | Navigation to the parent or previous surface. | `DayView`, `PageHeader` |
| `backdrop` | The overlay scrim behind a panel. | `LoadingOverlay` |
| `badge` | An auxiliary badge attached to a label. | `RoleSelector`, `Tabs` |
| `bar` | A chart datum rendered against a track. | `Chart` |
| `body` | The primary content region of a component or item. | `Alert`, `Avatar` |
| `cancel` | The dialog cancellation command. | `ConfirmDialog` |
| `caption` | The accessible title of a table. | `DataTable` |
| `cell` | A cell in a table, grid, or repeated layout row. | `Calendar`, `CalendarView` |
| `clear` | The command that clears a field. | `SearchInput` |
| `close` | The command that dismisses a surface. | `Alert`, `CalendarView` |
| `confirm` | The dialog confirmation command. | `ConfirmDialog` |
| `control` | The field or choice-control shell, including its visible mark. | `Checkbox`, `CollectionList` |
| `count` | A count attached to a label or collection. | `CollectionToolbar`, `DayView` |
| `description` | Supporting prose or accessible instructions. | `Chart`, `DayView` |
| `display` | The formatted keypad readout, including its affixes. | `NumericKeypad` |
| `empty` | The region explaining an empty collection. | `CalendarView`, `DataTable` |
| `error` | Validation or failure feedback; a semantic feedback region, not a state modifier. | `DataTable`, `DictationStatus` |
| `event` | A calendar event, whether shown in a cell, across days, or in an agenda. | `Calendar`, `CalendarView` |
| `expand` | The command that reveals details of a table row. | `DataTable` |
| `field` | A field-registration or form-submission boundary. | `CameraCapture`, `RelationInput` |
| `filters` | The collection-filter surface. | `CollectionToolbar` |
| `footer` | The concluding region of a surface. | `Card`, `Modal` |
| `frame` | The chart coordinate frame around its axis and plot. | `Chart` |
| `grabber` | The sheet drag handle. | `PhoneSheet` |
| `graph` | The rendered chart graphic. | `Chart` |
| `grid` | The calendar/keypad grid or chart reference grid. | `Calendar`, `CalendarView` |
| `group` | A labelled group of related entries. | `CalendarView`, `DayView` |
| `guide` | The chart reference line for the explored datum. | `Chart` |
| `header` | The introductory or heading region of a surface or item. | `Calendar`, `CalendarView` |
| `high` | The forecast maximum temperature. | `DayView` |
| `icon` | A content or command icon. | `ColorSchemeToggle`, `DataTable` |
| `indicator` | A selected, progress, status, or expansion indicator; state stays on its owner. | `AccordionItem`, `Avatar` |
| `input` | A native form input or select. | `CameraCapture`, `Checkbox` |
| `item` | An entry in a list, menu, legend, or tree. | `Chart`, `CollectionList` |
| `key` | A keypad key. | `NumericKeypad` |
| `label` | A control or item label, including responsive and accessible alternatives. | `Avatar`, `Button` |
| `legend` | The chart series/datum legend. | `Chart` |
| `list` | A collection of related entries, options, or navigation links. | `Calendar`, `CalendarView` |
| `low` | The forecast minimum temperature. | `DayView` |
| `marker` | An auxiliary meaning-bearing marker, including required-field and typing markers. | `Alert`, `Chart` |
| `media` | Captured photo or camera preview media. | `CameraCapture` |
| `menu` | An overflow menu. | `Tabs` |
| `message` | Message text, transcript text, or status feedback. | `Alert`, `CameraCapture` |
| `meta` | Supplementary metadata. | `CalendarView`, `DayView` |
| `month` | The calendar month selector. | `Calendar` |
| `more` | The affordance or count for additional entries. | `Calendar`, `CalendarView` |
| `nav` | Calendar navigation and date-selection controls. | `Calendar`, `CalendarView` |
| `next` | Navigation to the next calendar period. | `Calendar`, `CalendarView` |
| `option` | A selectable option in a choice surface. | `Combobox`, `FilterChips` |
| `overflow` | The tab-overflow region. | `Tabs` |
| `page` | The rendered document page. | `DocumentViewer` |
| `panel` | A disclosed, popup, dialog, or selected-content region. | `AccordionItem`, `CalendarView` |
| `picker` | The trigger for native file selection. | `CameraCapture` |
| `placeholder` | A skeleton content placeholder, independent of its shape. | `Skeleton` |
| `plot` | The chart plotting/interaction surface. | `Chart` |
| `prefix` | The prefix affix of a numeric readout. | `NumericKeypad` |
| `previous` | Navigation to the preceding calendar period. | `Calendar`, `CalendarView` |
| `progress` | The aggregate progress readout. | `LoadingOverlay` |
| `reactions` | The reactions attached to a message. | `MessageBubble` |
| `readout` | The chart or keypad value readout region. | `Chart`, `NumericKeypad` |
| `resize` | The table-column resize handle. | `DataTable` |
| `retry` | The command that retries a failed operation. | `DataTable`, `DocumentViewer` |
| `role` | The membership role. | `MembershipCard` |
| `row` | A repeated table, grid, or layout row. | `Calendar`, `CalendarView` |
| `scale` | The chart value-axis scale labels. | `Chart` |
| `search` | The collection or permission search region. | `CollectionToolbar`, `PermissionPicker` |
| `slice` | A datum in a proportional chart. | `Chart` |
| `sort` | The command that changes column sorting. | `DataTable`, `SortableHeader` |
| `spacer` | An intentional layout or virtual-scroll spacer. | `CollectionToolbar`, `DataTable` |
| `spinner` | An indeterminate activity indicator. | `Button`, `CollectionList` |
| `status` | The live or supplementary status region. | `Chart`, `Combobox` |
| `submit` | The keypad submission command. | `NumericKeypad` |
| `summary` | The aggregate working-status summary, optionally interactive. | `WorkingStrip` |
| `swatch` | The legend key identifying a chart datum. | `Chart` |
| `tab` | A tab-navigation option. | `Tabs` |
| `table` | A data table or accessible chart-data alternative. | `Chart`, `DataTable` |
| `thumb` | The movable switch/toggle thumb. | `Switch`, `Toggle` |
| `time` | An event, message, or metadata timestamp. | `CalendarView`, `DayView` |
| `title` | The heading or name of a surface, group, or item. | `Alert`, `Calendar` |
| `today` | Navigation to the current date. | `Calendar`, `CalendarView` |
| `track` | The track behind an indicator, thumb, or chart bar. | `Chart`, `LoadingOverlay` |
| `trigger` | The primary command that opens, selects, or activates a surface/date. | `Calendar`, `CalendarView` |
| `unit` | The unit affix of a numeric readout. | `NumericKeypad` |
| `value` | The presented numeric, progress, page, or selected value. | `Chart`, `ConfidenceBadge` |
| `venue` | The event location. | `DayView` |
| `weather` | The aggregate forecast readout. | `DayView` |
| `year` | The calendar year selector. | `Calendar` |

## Cascade layers

Every component `<style>` block declares and uses the smrt layers, lowest to
highest: `smrt.reset < smrt.structure < smrt.theme`. smrt-ui components split layout and interaction rules into `smrt.structure`
and paint and motion into `smrt.theme`. All component style blocks across the repository are sorted. Unlayered consumer CSS always beats every smrt
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
3. Use role-named `data-smrt-part` hooks for internal regions, scoped through the component root.
4. Import `unstyled.css` and supply an unlayered theme when replacing all component paint.

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

- **Structure survives:** `display`, `flex-direction`, `grid-template-columns`,
  `gap`, `padding`, `margin`, `width`, `height`, `position`, `inset`, `overflow`,
  `white-space`, `cursor`, and `pointer-events`. Transparent hit areas, hidden
  native inputs (`opacity: 0`), and stateful Switch thumb `transform` are
  structural too. Nested components in slots retain their own structure.
- **Theme is removed exactly:** `all: revert-layer` in `smrt.theme` targets
  `[data-smrt-component]` roots, every descendant, and `::before` / `::after`.
  `background`, complete `border` declarations, `border-radius`, `box-shadow`,
  `color`, `font`, `outline`, `filter`, `transition`, and `animation` fall back
  through `smrt.structure` to `smrt.reset` and browser defaults. Typography
  changes can change text wrapping and intrinsic dimensions; authored layout
  remains. CSS `all` does not reset custom properties, `direction`, or
  `unicode-bidi`.
- **Reset:** component text uses `font: inherit`; buttons, inputs, selects, and
  textareas also reset `margin`, `padding`, `border`, `border-radius`,
  `background`, and `color`, removing native control chrome. Higher structure
  declarations restore control spacing and hit targets.
- **Specificity:** each selector has three `:not(#\#)` boosts, `(3,1,0)` on
  elements and `(3,1,1)` on pseudo-elements. This beats Svelte's scoped selectors
  without `!important`.
- **Restyle:** tokens such as `--smrt-color-primary` and `--smrt-radius-md`
  customize the stock theme. Unlayered CSS wins over every smrt layer. Scope
  `[data-smrt-part="header"]` through `[data-smrt-component="Card"]` to style
  a role. For a complete theme replacement, import `unstyled.css` and supply
  your own unlayered `background`, `border`, `color`, and `font` rules.

The Styleless Mode entry has one toggle for the production stylesheet. The
Styleless Shell entry in smrt-svelte covers shell regions and a Disclosure inside
a Card slot. There is no experimental reset or component allow-list.

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


In development, `ThemeProvider` checks `--smrt-color-background` on its wrapper
once after mount and warns if a built-in preset has no resolved token. Import
`@happyvertical/smrt-ui/themes/styles/<preset>.css` (or `themes/styles/all.css`)
in the app. The check runs after persisted preferences settle, skips custom
themes and `inlineVariables={true}`, and is absent in production and SSR. It
never injects a preset stylesheet or token values.

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
- Every reachable component is now sorted. The production reset uses
  `all: revert-layer` on complete component subtrees and their pseudo-elements;
  transparent hit targets remain in structure.

The Styleless Mode fixture includes all ten primitives and one production toggle.
The previous candidate stylesheet and experimental checkbox are removed.

## Sorting a wave-3 slice

Preview only the assigned files, then write the same selection:

```sh
node scripts/codemod-smrt-sort-layers.mjs --check --file packages/smrt-ui/src/components/ui/Avatar.svelte --report /tmp/avatar-sort.json
node scripts/codemod-smrt-sort-layers.mjs --write --file packages/smrt-ui/src/components/ui/Avatar.svelte --report /tmp/avatar-sort.json
```

Repeat `--file` for a slice, or use `--package smrt-ui` only when the whole package
is assigned. A selection is required; no arguments never rewrites the repository.
For a read-only repository inventory, use `--report` with no selection (optionally
followed by a JSON output path). It never enables a repository-wide `--write`.
`--check` (also the default) is read-only and exits 1 for pending changes or TODOs.
`--write` exits 1 when TODOs remain, even after writing the mechanical split.
A second run leaves the output unchanged and reports the remaining TODO markers.
Already sorted files are not reclassified.
The codemod output is the canonical formatting for sorted layers.
Use `--format` with an explicit selection to reformat already-sorted layers without reclassification.

The codemod puts `display`, `flex`, `grid-template-columns`, `gap`, `padding`,
`margin`, `width`, `height`, `position`, `inset`, `overflow`, `clip`, `white-space`,
`text-overflow`, and `cursor` in `smrt.structure`. It puts `color`, `background`,
`border` (including `border-width`), `border-radius`, `box-shadow`, `font-size`,
`outline`, `filter`, `transition`, and `animation` in `smrt.theme`. Selectors,
`:global()`, conditional wrappers, and declaration order within each layer are
preserved; keyframes stay intact in theme with animation, including declarations
such as `transform` inside them. Forced-colors paint stays in theme.

The JSON report contains each file's TODO line, selector/wrapper path, declaration,
and reason, plus counts of auto-placed and TODO declarations and an `unparseable`
flag. TODO declaration counts include declarations inside unresolved wrappers;
unparseable files have zero classified counts. Already sorted files contribute
zero auto-placed declarations. `opacity`, `transform`, `transform-origin`, `visibility`, `content`,
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
The gate is strict: any unsorted component or new un-namespaced owned class
fails. There is no ratchet file or `--write` escape. Empty `smrt.structure`
explicitly marks a paint-only component as sorted. Local CSS selectors, static
native-element class attributes and class directives count; repeated selectors
count once. `:global()` consumer classes and classes passed to child components
do not count. Dynamic expressions are checked through their local CSS selectors;
the gate does not prove every runtime-generated string is namespaced.

New private classes use `smrt-<component>__<part-or-modifier>`. Published class
families retain their names through a bounded allow-list in
`scripts/smrt-sort-layers-lib.mjs`, with boundary and source-scope tests:

- In smrt-svelte `workspace/`, `app/`, and `screens/`: `smrt-admin-shell`,
  `smrt-workspace-`, `smrt-phone-`, `smrt-shell-`, `smrt-activity-`,
  `smrt-app-scope-panel`, `smrt-hotkey-input`, `smrt-nav-editor`,
  `smrt-section-menu`, `smrt-shortcuts-overlay`, `smrt-system-scope-panel`,
  `smrt-system-status-chips`, `smrt-tenant-nav`, `smrt-role-shell`,
  `smrt-nav-tree`, `smrt-breadcrumbs`, `smrt-dock-toggles`, `smrt-app-shell`,
  `smrt-layout-`, `smrt-edit-`, `smrt-owner-setup`, `smrt-recipe-screens`.
  Names ending in `-` are family prefixes; other names accept only the exact
  root or a `-` / `__` boundary. These published names are already namespaced;
  generic helpers and state classes are not exempt.
- Subscription roots, each only in its matching `.svelte` file under
  `packages/subscriptions/src/svelte/`: `PlanPicker` → `smrt-plan-picker`,
  `SubscriptionSummary` → `smrt-subscription-summary`, `UsageThresholds` →
  `smrt-usage-thresholds`. Only the root and `__` / `--` descendants qualify.

Planner's shared `planner-forms.css` and `planner-lists.css` use
`smrt-planner-form__*` / `smrt-planner-list__*` classes and the same structure/theme
split as components. There are no legacy private class exceptions. Shared
sheets own form spanning, table treatment and sort controls across component
boundaries; component styles must not override their table border model.

The old pilot comparator and its mapping file are retired. The script tests
retain the ten hand-sorted primitives as idempotence fixtures and exercise strict
rejection, scoped published families, and the namespaced planner sheets.
