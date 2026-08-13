# @happyvertical/smrt-ui

Domain-agnostic Svelte 5 UI runtime for SMRT. This is the **leaf** of the
Svelte stack: it depends only on `svelte` (peer) and `@happyvertical/smrt-types`
— no smrt domain package — so domain packages (assets, commerce, content, …)
can consume UI primitives, i18n, the theme system, and the module UI registry
**without** taking a dependency on the top-level `@happyvertical/smrt-svelte`
integration layer. Extracting this leaf is what breaks the domain ⇄ smrt-svelte
peer cycle (see happyvertical/smrt#1582).

## The UI split — primitive-adoption contract (#1589)

SMRT has one shared set of UI primitives, split across two packages by concern:

- **`smrt-ui` (here) owns the domain-agnostic VISUAL primitives** — `Button`,
  `Card`, `Modal`/`ConfirmDialog`, `Badge`, `Avatar`, `Chip`, `Dropdown`,
  `Tooltip`, `Skeleton`, `Tree`, `Pagination`, `DataTable`, `ContentList`, … — **plus the
  Provider-free base FORM primitives** under `./forms` (`Form`, `Input`,
  `Select`, `Textarea`, `Checkbox`, `Switch`, `RadioGroup`, `Slider`,
  `RangeSlider`, `Combobox`, `MultiSelect`, `TagsInput`, `FilePicker`,
  `FormGroup`), relocated here in #1589's
  deferred-forms phase so domain packages can adopt them without pulling in the
  smrt-svelte Provider or closing a build-graph cycle. These are dependency-free:
  no Provider, no i18n, no spoken-input logic.
- **`smrt-svelte` owns the Provider-REQUIRED form primitives** — `CheckboxInput`,
  the rich `Form` (field registration + voice), `TextInput`, `MoneyInput`, and
  the specialized date/measurement/address/file inputs (they call `useAppState`
  / the AI hooks and carry i18n + spoken-input logic). It re-exports the base
  **input** primitives (`Input`, `Select`, `Textarea`, `Toggle`, `FormGroup`)
  from here so `@happyvertical/smrt-svelte/forms` stays the full barrel — but
  **not** `Form`: that barrel's `Form` is the rich Provider-backed one, so the
  Provider-free `Form` is only importable from `@happyvertical/smrt-ui/forms`.

**Domain packages import visual primitives from `smrt-ui` and form primitives
from `smrt-svelte`, and must not hand-roll raw `<button>` / `<input>` /
`<select>` / `<textarea>` / `<form>` markup** — re-rolling them re-introduces the
inconsistent a11y / focus / disabled-state behavior the primitives exist to fix.
Enforced by `scripts/check-raw-primitives.mjs` (report-only during the #1589
migration; flips strict per package as it adopts the primitives). smrt-ui's own
components are exempt — they *are* the primitives.

## What lives here

| Subpath | Contents |
|---------|----------|
| `.` | barrel re-exporting the primitives, registry, and theme system |
| `./playground` | shared-host previews for the complete foundation catalog; rendered inside the active preset and color scheme |
| `./ui` | `Button`, `Card`, `Badge`, `Avatar`, `Chip`, `Skeleton`, `Tooltip`, `Dropdown`/`Menu`, `Popover`, `Disclosure`, `Accordion`, `Tree`, `Pagination`, … |
| `./feedback` | `Alert`, `ToastViewport`, `Modal`, `Drawer`/`Sheet`, `ConfirmDialog`, `LoadingOverlay`, `Progress`, `Meter`, `Spinner` |
| `./data` | `CollectionToolbar`, `CollectionList`/`ContentList`, `DataTable` and their types |
| `./layout` | `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState`, … |
| `./calendar` | `Calendar`, `DayView` |
| `./chat` | `MessageBubble`, `ReactionPicker`, `TypingIndicator` |
| `./forms` | Provider-free fields, choice controls, sliders/ranges, combobox/listbox/multiselect/tags, date/time/file controls, plus the transport-neutral control interaction registry |
| `./i18n` | i18n **client**: `useI18n`, `<Trans>`, `defineMessages`, `renderTemplate` (no `smrt-languages` import — the server resolver stays in `smrt-svelte/i18n/server`) |
| `./registry` | `ModuleUIRegistry` for cross-package component discovery |
| `./theme` | deprecated compatibility path forwarding to the canonical theme system |
| `./themes` | canonical `ThemeProvider`, context, preset token system (material/glass/studio/smrt/happyvertical), and CSS generation |
| `./themes/styles/smrt.css` | static SMRT theme CSS (dark-first amber instrument-panel look) + signature `.smrt-*` flourish utilities |
| `./themes/styles/fonts.css` | optional self-hosted `@font-face` for the SMRT type stack (Space Grotesk / Inter / JetBrains Mono) |
| `./themes/styles/happyvertical.css` | static HappyVertical "Day Shift" brand CSS (enamel/faceplate calm instrument panel) + amber focus rule + `.hv-*` utilities |
| `./themes/styles/happyvertical-fonts.css` | optional self-hosted `@font-face` for the Day Shift type stack (Archivo / B612 / B612 Mono) |
| `./styles/tokens.css` | base token stylesheet |

Also internal: `actions/` (`ripple`, `permission`), `display/`, `data/`,
`nav/`, `permissions/`, `utils/`, `test-support/`.

## Playground

The package publishes `./playground` and keeps its workspace source at
`src/svelte/playground.ts`. Previews inherit the shared host's active
Material/Glass/Studio/SMRT/HappyVertical preset and light/dark color scheme;
preview components must consume `--smrt-*` tokens rather than installing their
own theme provider or static preset stylesheet.

## Theme presets

Adding or editing a preset touches four things that must stay in lockstep:
`src/themes/<id>/index.ts` (the `Theme`), the `ThemePreset` union in
`src/themes/types.ts`, the `registry.ts` entry, and the static
`src/themes/styles/<id>.css`. **The static stylesheet's `[data-theme="<id>"]`
blocks are `generateThemeCSS()` output verbatim** — regenerate them after any
token edit, never hand-patch a value. Two guards enforce this: the whole-block
comparison in `__tests__/happyvertical-theme.test.ts` (per-preset, strictest),
and the name-surface diff in `__tests__/token-aliases.test.ts` plus
`scripts/check-svelte-tokens.mjs` (repo-wide). A preset that tunes shadows per
scheme sets `darkElevation`; one whose type stack names its own monospace face
sets `fontFamilyMono` (#1586, #1431).

The **happyvertical** preset ("Day Shift", #2318) is the HappyVertical brand
identity and carries hand-authored light *and* dark palettes — never regenerate
its dark scheme from the light one. Its brand rules are executable in that test:
green is a lamp/marker/fill and never a text color, dark keeps a blue-graphite
cast with both accent hues, focus is a 2px amber outline with offset, and every
other text pairing clears WCAG AA in both schemes.

## Rules

- **No smrt domain imports.** A `@happyvertical/smrt-*` import other than
  `smrt-types` reintroduces the cycle. Components consume `var(--smrt-*)` CSS
  tokens directly and accept identity data via `smrt-types` contracts.
- **Identity-data UI is fine; domain-*importing* UI is not.** The line is "does
  it import a domain package," not "is it identity-related." Components that only
  render identity records through the `smrt-types` contracts are domain-agnostic
  and live here — including `RoleBadge` / `RoleSelector` / `MembershipCard` /
  `MembershipList`. Composites that actually import a domain package — admin
  shells (`@happyvertical/smrt-agents/ui`) or forms wired to `smrt-svelte`'s AI
  hooks / browser-ai — live in `@happyvertical/smrt-svelte`, which depends on
  this package.
- Built with `svelte-package`; consumed via the `svelte` export condition.
- Form controls expose stable `formId` + `controlId` identity through the
  interaction registry. Keep chat/voice transports outside this package;
  mutations must retain sensitivity checks and the stage → confirmed apply
  policy.

## Gotchas

- **i18n split**: the client (here) is dependency-free; the Node-only server
  resolver (`buildI18nSnapshot`, → `@happyvertical/smrt-languages`) stays in
  `@happyvertical/smrt-svelte/i18n/server`. Package string catalogs register via
  `defineMessages` imported from `@happyvertical/smrt-ui/i18n`.
