# @happyvertical/smrt-ui

The domain-agnostic Svelte 5 component foundation for s-m-r-t. Components use the
shared `--smrt-*` design tokens, render without a s-m-r-t Provider, and can be used
by any package or application without pulling domain dependencies into the UI
layer.

```bash
pnpm add @happyvertical/smrt-ui
```

```svelte
<script lang="ts">
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { Form, FormGroup, Input, Switch } from '@happyvertical/smrt-ui/forms';
  import '@happyvertical/smrt-ui/themes/styles/base.css';
  import '@happyvertical/smrt-ui/themes/styles/material.css';
</script>

<ThemeProvider preset="material" colorScheme="system">
  <Form formId="profile">
    <FormGroup label="Display name"><Input name="displayName" /></FormGroup>
    <Switch name="updates" label="Product updates" />
    <Button type="submit">Save</Button>
  </Form>
</ThemeProvider>
```

## Foundation catalog

| Area | Components |
| --- | --- |
| Fields | `Form`, `Field`/`FormGroup`, `Fieldset`, `InputGroup`, `ErrorSummary`, `FormActionBar` |
| Text and structured input | `Input`, `Textarea`, `Select`, `Combobox`, `RelationInput`, `Listbox`, `MultiSelect`, `TagsInput`, `SearchInput` |
| Choices | `Checkbox`, `RadioGroup`/`Radio`, `Switch`, `Toggle`, `ToggleButton`, `SegmentedControl` |
| Values and files | `Slider`, `RangeSlider`, `DatePicker`, `TimePicker`, `FilePicker` |
| Capture | `CameraCapture`, `SignaturePad` |
| Actions and display | `Button`, `Dropdown`/`Menu`, `Badge`, `Chip`, `Avatar`, `Card`, `Skeleton`, `Tooltip`, `Tree` |
| Disclosure and overlays | `Popover`, `Disclosure`, `Accordion`/`AccordionItem`, `Modal`, `Drawer`/`Sheet`, `PhoneSheet`, `ConfirmDialog` |
| Feedback | `Alert`, `ToastViewport`, `Progress`, `Meter`, `Spinner`, `LoadingOverlay`, `WorkingStrip` |
| Collections | `CollectionToolbar`, `CollectionList`/`ContentList`, `DataTable`, `Pagination` |
| Layout and navigation | `Container`, `PageLayout`, `Grid`, `ActionGroup`, `Header`, `Footer`, `PageHeader`, `EmptyState`, `Tabs`, `FilterChips` |
| Calendar | `CalendarView` (deprecated: `Calendar`, `DayView`) |

### Phone surfaces

- `PhoneSheet` (`/feedback`) is the phone replacement for drawers and centered
  modals: `variant="page"` covers the area, `variant="sheet"` rises from the
  bottom and closes on a swipe down its header. It is non-modal, closes on its
  button and Escape, returns focus to the opener, and can stay mounted while
  closed (hidden and inert) so its content keeps state. It is
  `position: absolute; inset: 0` — render it in AdminShell's `overlays`.
- `WorkingStrip` (`/feedback`) shows a transport-neutral `WorkingStatus`
  (`idle` · `working` · `paused` · `waiting` · `done` · `failed` ·
  `cancelled`, a `label` for the current step and an optional `goal`) as a
  strip above a phone bottom bar, a floating pill (`variant="floating"`, the
  host positions it), or a line at the top of a pane. Optional controls:
  reopen (`onopen`), Pause/Continue (`onpause`/`onresume`; Escape pauses),
  Review while waiting (`onreview`), Stop, and Close once finished
  (`ondismiss`); all 44px. Done uses the success colors, failed the error
  colors, always with an icon and text. Step changes are announced politely
  (throttled by `announceIntervalMs`), `waiting` and `failed` assertively; it
  never takes focus.
- `FormActionBar` (`/forms`) groups a form's actions (primary last). On phones
  it is fixed to the bottom, carries `data-form-action-bar` so AdminShell hides
  its phone bottom bar, and hides while `:root[data-keyboard-open]`.
- `swipeDismiss` / `swipeDismisses` (`/feedback`) are the touch action and pure
  decision behind swipe-to-close.
- `Dictation` / `DictationButton` / `DictationStatus` (`/forms`) let people
  speak into a text field (tap the microphone, or press and hold the field
  with `longPress`). The speech `source` is normally smrt-svelte's
  `createSttDictationSource()` (the browser's own speech recognition). Give
  it a `transcribe` function too (`createHttpTranscriber('/your/route')`)
  and, where the browser has no speech recognition (Firefox) or no speech
  service behind it (Brave: `network` / `service-not-allowed`), it records
  the message with `MediaRecorder` instead (WebM/Opus, MP4 on Safari; at most
  `maxDurationMs` 2 minutes and `maxBytes` 10 MB), shows "Writing it down…"
  while the route turns it into text, and puts the text at the cursor.
  Keep the speech service's key on the server: the route takes the raw audio
  body (`Content-Type` is the recording's type, `?language=&durationMs=`)
  and answers `{ text }`; 413, 503 and 401/403 become "too long", "not set
  up" and "not allowed" messages.
- Hands-free dictation: `new Dictation({ mode: 'hands-free', handsFreeCapture:
  createHandsFreeCapture, … })` keeps the microphone on and writes each
  sentence down when the speaker pauses; one tap on the microphone ends it.
  `createHandsFreeCapture` comes from `@happyvertical/smrt-ui/forms/hands-free`,
  the one entry that imports the optional peer `@happyvertical/speech`
  (>= 0.102.5: on-device voice activity detection with an adaptive noise
  floor, pre-roll and a 30 s split; no audio leaves the page). It needs a
  speech source with `transcribePcm` (smrt-svelte's on-device `whisper-local`
  and `moonshine`); with any of the three missing it is plain press-to-talk.
  Utterances are written down one at a time in the order spoken
  (`dictation.queued` counts those waiting); `speaking` and `level` (0 to 1)
  drive the button: a steady ring while listening, a halo that swells with the
  voice while speaking, a spinner while writing down, all still under
  `prefers-reduced-motion`. `vad` tunes `silenceMs` (default 800),
  `minSpeechMs`, `preRollMs`, `maxUtteranceMs` and `sensitivity`.
  The help text ("Just talk; I write it down when you pause...") is the
  microphone's tooltip and `aria-describedby`, not a line in the form;
  `DictationStatus` keeps a visually hidden polite live region ("Listening",
  "Hearing you...", "Writing it down...") and shows errors. Its `sending` prop
  adds the one short visible hint, "Sending...". The chat composer's
  `sendOnPause` / `sendOnPauseMs` (default 1200) builds send-on-pause on it.
  Half-duplex: browsers do not reliably cancel `speechSynthesis` from the
  microphone, so call `dictation.suspend()` while the page reads a reply aloud
  and `dictation.resume()` after (the chat composer/dock do this from their
  `speaking` prop). The microphone stays open but nothing is heard (an
  utterance in progress is discarded, a ~350 ms guard follows `resume()`);
  `dictation.suspended` drives the dimmed, dashed-outline button and the
  "Paused while the assistant speaks" tooltip/live region. A custom
  `HandsFreeCapture` may implement optional `suspend()` / `resume()`;
  `Dictation` ignores utterances that arrive while suspended either way.

### Link tabs

`Tabs` with an `href` on every tab renders a page's sections as navigation —
a `<nav>` of links, `aria-current="page"` on the active one, each tab its own
URL — instead of an ARIA tablist. `maxVisible` moves extra tabs into a "More"
menu while the active tab always stays in the row (`splitTabs` is the pure
rule), `badge` marks a tab needing attention (and dots "More" when a hidden
tab has one), and the row scrolls sideways on phones with the active tab
kept in view. It carries `data-shell-tabs`, so AdminShell keeps it sticky
under the phone top bar. Pair it with `useLinkSurface` (smrt-svelte) so
agents can switch tabs too.

Use the focused subpaths (`/forms`, `/form-retry`, `/ui`, `/feedback`, `/data`,
`/data-surface`, `/currency`, `/layout`, `/themes`) to keep imports explicit. The
Svelte-free `/data-surface` entry exposes the registry contracts and shared
protocol limits for server adapters; the Svelte-free `/form-retry` entry
exposes the form-retry helper. The Svelte-free `/currency` entry exposes
`ISO_4217_MINOR_UNITS`, the shared ISO 4217 registry used for deterministic
minor-unit scaling. A missing code is unsupported; a `null` value is a valid
ISO fund, metal, test, or no-currency code without a defined minor unit, so
callers handling integer minor-unit money must reject both cases rather than
inventing a decimal precision. The package root remains a compatibility barrel.

### Calendar dates and shop time

`DateDisplay` accepts `timeZone` (an IANA id such as `America/Edmonton`) for
instant inputs (`Date`, numeric timestamps, and timestamp strings). Omit it to
keep browser-local absolute formatting and the existing duration-based relative
format. With an explicit zone, relative today/yesterday/tomorrow boundaries use
calendar days in that zone, including daylight saving transitions.

A bare `YYYY-MM-DD` string always denotes that calendar date, independent of the
viewer or shop zone. It formats in UTC, retains a date-only `datetime` attribute,
and ignores `showTime` because it contains no time. Relative calendar-date
labels compare it with today's date in the supplied zone (or the browser zone).
Impossible calendar dates render `fallback`. Invalid explicit zones used for
instant or relative formatting also render `fallback` rather than throwing.

### Combobox form submission

A named `Combobox` submits its selected option value through a hidden native
input. Its visible search text and option label are display-only. With
`allowCustom`, typed text becomes the submitted value; otherwise searching keeps
the last committed selection. A named empty selection submits an empty string;
controls with no name or an empty name are omitted. Disabled controls, including
those inside disabled fieldsets, are omitted by native `FormData`. Native form
reset restores the initial selection and its label, unless reset is canceled.

### RelationInput

`RelationInput` (`/forms`) moved here from `@happyvertical/smrt-svelte/forms` in #3637 (originally #3600); smrt-svelte keeps a deprecated re-export. Labels are props (`createLabel`, `clearLabel`, `loadingText`, ...); there is no message catalog.

Searchable single-select for relation (foreign-key) fields, a thin wrapper over
`Combobox`. It is presentation only: the caller supplies the data,
so the same lookup an assistant uses to turn "Acme" into a record id backs the
picker. Option shape is `RelationOption` — `{ id, label, detail? }`.

- **Props.** `name`, `label`, `value` (bindable id, `''` = none), `required`,
  `disabled`, `error`, `placeholder`, `description`, `search(query)`, optional
  `resolve(id)` and `onCreate(query)`, plus `debounceMs` (250), `interaction`,
  `onchange` and overridable text (`createLabel`, `clearLabel`, `loadingText`,
  `emptyText`, `errorText`, `resultsText`).
- **`search`** runs with `''` when the list opens and then debounced per
  keystroke; a response for a superseded query is dropped. A rejected search
  shows `errorText` and the next keystroke retries.
- **`resolve`** supplies the label of a `value` that has not been searched yet
  (initial value, parent rebind, form reset). Without it such a value shows an
  empty field, never the raw id. A `null` result also leaves the field empty.
- **`onCreate`** adds a "New ..." button; it receives the text most recently
  searched for and may return the created `RelationOption`, which is selected.
- **Form integration** is through `Combobox`'s control registration (`Form`
  provides the registry), not a `FieldDefinition`: agents see a `combobox`
  control whose value is the id. The form posts the id under `name`.
- **Known limit.** An agent staging a value through the registered control can
  only choose among the options last listed (the registry matches against
  `options`; `allowCustom` is off), so it cannot write an id it has not
  searched. It fails closed. Writing a resolved id needs an async hook on
  `Combobox` and is tracked separately.
- **Stale options.** Typing clears the listed options until the new search
  answers, so Enter or a click can never pick a record for an older query.
- **Clear button** shows only when not `required`, not `disabled`, and a value
  is set; it returns focus to the field.
- **Accessibility** is the combobox pattern (`role=combobox`, `aria-expanded`,
  `aria-activedescendant`, listbox/option, Arrow/Enter/Escape) plus a polite
  `role=status` live region announcing searching / "N results" / no matches,
  `aria-busy` while fetching, and `aria-invalid` + `aria-describedby` for
  `error` and `description`.
- Options render `detail` under the label, so the option's accessible name
  includes it. The `Combobox` additions that make this possible (`filter`,
  `onquery`, `status`, `busy`, `invalid`, `describedby`, `optionContent`) are
  generic and default to the previous behaviour.

### MultiSelect form submission

A named `MultiSelect` submits one hidden native input per selected option value,
using repeated field names in selection order. Read them with `FormData.getAll`.
Option labels are display-only, and numeric option values submit as strings.
Empty selections, missing or empty names, and disabled controls (including
ancestor fieldsets) contribute no entries. Native reset restores the initial
selection unless reset is canceled.

### Listbox form submission

A named `Listbox` submits one hidden native input containing its selected option
value, with numeric values encoded as strings. A named listbox without a
selection submits an empty string. Missing or empty names and disabled controls
(including ancestor fieldsets) are omitted. Native reset restores the initial
selection unless reset is canceled.

### Status badge tones

`StatusBadge` accepts `tone="success"`, `"warning"`, `"danger"`, `"info"`, or
`"neutral"` for custom status vocabulary such as `awaiting_cert`. An explicit
tone overrides the built-in domain scheme while label, size, and outline variant
continue to work independently. Tones use the active theme's paired container
and text tokens. Without a tone, known domain statuses retain their existing
colors and unknown statuses retain the neutral fallback. `StatusTone` is exported
as a TypeScript type from the package root.

### Touch targets for Checkbox, Radio and Switch

`Checkbox`, `Radio` and `Switch` have an invisible 44x44px hit area around the
visible control (about 18px for a box or mark, the 2.75rem track for a switch).
A transparent `::before` on the wrapping `<label>` makes it, so a click anywhere
in the area toggles the input, no layout shifts, and the focus ring stays on the
visible box. The box and the label text sit above every hit area, so adjacent
controls never steal each other's clicks.

The hit area paints above plain (unpositioned) content around it, so it is
constrained to where that cannot cost a neighbour a click:

- **Beside other content.** A `Checkbox` or `Radio` that is not the only element
  in its parent (a row title or link next to it, a group's other options) keeps
  its hit area in the box's own column: it grows vertically only, never over the
  text or link beside it. Only a control standing alone gets the full 44x44.
- **Table cells.** Inside a `td`/`th` the area never leaves the cell. A
  `Checkbox` that is the cell's only content uses the whole cell (clipped to its
  edges). The cell gets `position: relative` at zero specificity (`:where()`), so
  a sticky header or a pinned column keeps its own positioning.
- **Stacked controls.** Hit areas of tightly stacked controls overlap in the
  gaps; the later control wins a gap, never a neighbour's box or text. Content
  directly above or below a box, closer than 13px, is covered by its hit area:
  give it room, or shrink the area with `--smrt-control-hit-size`.
- **Resize or turn off.** `--smrt-control-hit-size` (default `2.75rem`); `0px`
  gives only the visible control. Pages never add their own padding hacks.
- `DataTable`'s built-in selection checkboxes and `CollectionList`'s select box
  are still native inputs and do not use this yet.

## Calendar

`CalendarView` (`@happyvertical/smrt-ui/calendar`) provides generic month and week grids
with a phone agenda:

```svelte
<script lang="ts">
  import { CalendarView } from '@happyvertical/smrt-ui/calendar';
  import { goto } from '$app/navigation';
  let { data } = $props(); // { year, month, items }
</script>

<CalendarView
  items={data.items}
  year={data.year}
  month={data.month}
  timeZone="America/Edmonton"
  onNavigate={({ year, month }) => goto(`?y=${year}&m=${month}`, { keepFocus: true })}
/>
```

- **Items** are generic `CalendarItem`s: `{ id, title, start, end?, allDay?,
  tone?, color?, label?, group?, href? }`. `start`/`end` take a `Date`, an ISO
  date-time, or a `YYYY-MM-DD` date (all-day). Timed `end` is exclusive; an
  all-day `YYYY-MM-DD` end is the inclusive last day, and an all-day end
  instant at local midnight is exclusive. `tone` maps to the theme's color
  roles; without it, `group` picks a stable tone. Items with `href` render as
  links, others as buttons; both call `onItemSelect`.
- **Time zone and locale**: every day is computed in `timeZone` (IANA;
  defaults to the browser's — pass it explicitly so server and client
  agree). Month, weekday, date, and time text come from `Intl` in `locale`
  (defaults to the i18n locale); `weekStartsOn` defaults to the locale's.
- **Modes**: `month` is a `role="grid"` month with roving focus (arrows,
  Home/End, PageUp/PageDown cross months). All-day and multi-day items are
  bands across the days they cover; a day with more than `maxPerDay` rows
  shows "+N more", which opens the day in a panel under the grid, or follows
  `dayHref` when given. `agenda` is a horizontally scrolling strip of the
  month's days (44px targets, arrow keys) above a day-by-day list. `auto`
  (default) uses the agenda below 48rem, matching AdminShell's phone
  breakpoint. No modals.
- **Week view**: pass `mode="week"` and `date="2026-09-29"` to show the seven
  days containing that date. `onNavigate` reports `{ year, month, date }`, where
  `date` is the first day of the week. Previous/next and PageUp/PageDown move
  one week; Today uses `timeZone`. Use `mode="auto" autoMode="week"` for a week
  grid above 48rem and that week's agenda below it (the default `autoMode`
  remains `month`). The week title uses the requested locale's date range.
  Bands, overflow, day links, selection and keyboard grid behavior match month
  mode. Handle `onNavigate` with `if (next.date) week = next.date` to retain the
  controlled date in a page or URL.
- **URL state**: `year` + `month` (1-12) and `selectedDate` (`YYYY-MM-DD`) are
  controlled when passed; changes are reported via `onNavigate` and
  `onSelectDate`, so a page can keep them in its URL.
- The Svelte-free date model (`toEntries`, `layoutMonth`, `layoutWeek`, `weekKeys`, `dateKeyInZone`,
  `monthWeeks`, `shiftMonth`, …) is exported from the same subpath for
  server-side range queries and tests.

**Migrating from `Calendar` / `DayView` (deprecated).** They compute days in
the browser zone, print English-only names, and hard-code game/meeting/event
emoji and routes. Map each `DayEventDetail` to a `CalendarItem` (`name` →
`title`, `type` → `group`/`label`, your own route → `href`), replace
`Calendar`'s `year`/`month` (0-indexed) with `CalendarView`'s `year`/`month`
(1-12) and `onMonthNavigate` with `onNavigate`, `baseUrl` with a `dayHref`
function that builds your day route from the `YYYY-MM-DD` key, and a `DayView`
page with `CalendarView` in agenda mode (`selectedDate` set to the day) or the
month grid's day panel. They will be removed in a future minor release.

### Currency display

`CurrencyDisplay` accepts ISO 4217 codes as a public `string` prop so persisted
Commerce currency fields can be passed directly. Codes are trimmed and
uppercased before `Intl.NumberFormat` formatting; the default remains CAD.
Malformed or unsupported codes render an accessible inline error instead of
throwing and interrupting a surrounding collection render.
With the default historical `unit="cents"` setting, amounts are interpreted as
the selected currency's ISO minor units (for example, 0 digits for JPY and 3
for BHD). Minor-unit amounts must be finite safe integers; fractional or unsafe
numeric values render an accessible inline error instead of being rounded.
`unit="dollars"` means the value is already in major units.
ISO fund, metal, test, and no-currency codes whose minor unit is `N.A.` require
`unit="dollars"`; the default minor-unit mode renders an accessible inline
error for those codes. Major-unit values for these codes use a stable two-digit
display policy across server and browser runtimes. CAD and USD retain their
symbol display; all other codes render their ISO code so SSR output does not
depend on runtime-specific symbol data.

```svelte
<script lang="ts">
  import { CurrencyDisplay } from '@happyvertical/smrt-ui';
  let invoiceCurrency: string = 'eur';
</script>

<CurrencyDisplay amount={12345} currency={invoiceCurrency} />
```

## Component standard

Foundation components follow one contract:

- Native HTML semantics first, with labelled controls, keyboard interaction,
  focus-visible states, disabled/read-only handling, and reduced-motion rules.
- Svelte 5 bindable state plus explicit change callbacks for controlled use.
- SSR-safe IDs from `$props.id()` and stable `name`-based interaction identity.
- Styling only through semantic `--smrt-*` tokens; no component owns a theme.
- Loading, empty, invalid, indeterminate, and disabled states are visible and
  announced where applicable.
- Provider-free implementation and no domain imports.
- Focused interaction tests and axe checks for composed controls.

Application-specific editors, maps, charts, media workbenches, and domain
records remain composites built from this foundation rather than generic base
components.

## Native and enhanced forms

`Form` forwards native form attributes and Svelte attachments through its rest
props to the underlying `<form>`. For a SvelteKit action, adapt `enhance` with
`fromAction` and set `preventDefault={false}` so the enhancement handles submission:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import { fromAction } from 'svelte/attachments';
  import { Form, Input } from '@happyvertical/smrt-ui/forms';
</script>

<Form method="POST" action="?/save" preventDefault={false} {@attach fromAction(enhance)}>
  <Input name="displayName" />
  <button type="submit">Save</button>
</Form>
```

For a customized enhancement, pass its callback as a getter:
`{@attach fromAction(enhance, () => submitFunction)}`. The attachment runs on the
native element and cleans up when it unmounts; the interaction registry and
staged-review surface remain available. A component reference obtained with
`bind:this` exposes `getFormElement(): HTMLFormElement | null`, which returns
`null` before mount and after unmount. For ordinary browser GET/POST forms, use
`preventDefault={false}` without an attachment. The default remains `true` for
existing handler-driven forms.

## Agent-addressable forms

`Form` can expose its controls to a chat, voice, tutorial, or test adapter
without coupling controls to a transport:

```svelte
<script lang="ts">
  import {
    Form,
    FormGroup,
    Input,
    createControlInteractionRegistry,
  } from '@happyvertical/smrt-ui/forms';

  const registry = createControlInteractionRegistry();

  async function proposeName() {
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'profile', controlId: 'displayName' },
        value: 'Ada Lovelace',
      },
      { source: 'agent' },
    );
  }
</script>

<Form formId="profile" interactionRegistry={registry}>
  <FormGroup label="Display name">
    <Input name="displayName" />
  </FormGroup>
</Form>
```

Controls publish serializable metadata, constraints, options, sensitivity, and
capabilities. Adapters can focus, reveal, highlight, explain, validate, and
stage reviewable proposals. An agent never moves keyboard focus: its `focus`
reveals and highlights the control instead. Agents cannot apply, discard, clear, or undo;
those value-changing actions require a trusted local gesture handled by the
framework review surface. Secret/read-only controls reject agent mutations.
Staging remains separate so proposals never change user state before review.
Custom local review controls can call `executeLocalControlCommand` or
`executeLocalControlBatch` synchronously from their DOM handlers; the registry
requires the event to still be actively dispatching, snapshots the complete
command, and consumes the gesture before authorizing a value-changing command.
Retaining an event for later use is rejected even when it remains trusted.
Serialized or programmatic `source: 'user', confirmed: true` input is never
confirmation. Sensitive and secret values, validation details, failures, and
events remain redacted from every public surface.
The shared review surface marks its complete edited Apply value with
`reviewedValueIsCanonical: true`. That marker carries no authority: the registry
honors it only for a current staged entry after validating the exact command
under an actively dispatching local gesture. Controls with non-idempotent
proposal preparation can implement `prepareReviewedValue(value)` to validate or
canonicalize the complete displayed value without re-applying proposal-relative
behavior. Controls without that hook route marked edits through their ordinary
`prepareValue`, so a generic marker never bypasses custom normalization or
rejection. An unchanged value exactly equal to the stored staged canonical value
uses that trusted stored value directly.
Registries expose optional `refresh(formId)` notification for hosts whose live
metadata or runtime-state getters change without a registration event; it
updates subscribers without discarding an internal staged proposal.
`executeBatch` is an additive optional registry method; Forms fall back to
ordered `execute` calls for older injected registries. Factory-created
registries retain the framework's private, one-shot gesture proof, while an
older custom registry remains responsible for its pre-existing execution
policy and accepts review actions only from a trusted browser event.
Custom controls whose clear operation is intentionally idempotent should return
`true` from `clear()` to affirm that the unchanged cleared value was accepted.
Async custom setters and clear handlers are rolled back when they reject. A
control that permits direct edits while an async mutation is pending can expose
`getUserEditSnapshot()` and update its revision and value only for direct user
edits so rollback restores newer human input even if the handler mutates again
before rejecting. A fallible async setter should also expose `restoreValue()` as
an infallible state restoration path that does not repeat the external workflow.
Async policy, validation, setter, clear, and restoration hooks receive an
optional final `ControlExtensionContext`. Hooks that need to issue another
control command should use `extension.execute()`; it rejects a mutation of the
same control immediately, while commands from independent callers remain in
the normal ordered queue regardless of how long the hook takes. Existing hooks
that omit the additional argument remain compatible. Setters retain their exact
legacy `setValue(value)` invocation; a setter that needs this context implements
the additive `setValueWithContext(value, extension)` hook instead. A hook must
not await a same-control mutation through a captured registry reference: that
call is indistinguishable from an independent caller in browser runtimes and,
like any hook that never settles, can hold the ordered queue indefinitely.

### Composite controls and form proposals

A composite field — a place picker, a slug field with its own preview, a
record picker — registers as ONE control with `useControlRegistration` (call
it during component init inside any `Form`, rich `Form`, or `FormScope`). Give
it a stable `controlId`, a plain `label`, and, when its value is not a plain
string/number/boolean, a `valueSchema` so adapters can describe it:

```svelte
<script lang="ts">
  import { useControlRegistration } from '@happyvertical/smrt-ui/forms';

  let { value = $bindable(null) } = $props();

  useControlRegistration(() => ({
    controlId: 'place',
    metadata: {
      kind: 'custom',
      label: 'Town location',
      valueSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' } },
      },
    },
    getValue: () => value,
    setValue: (next) => { value = next; },
  }));
</script>
```

Call `recordControlUserEdit(context, controlId, subject)` from the
composite's own user-event handlers so a staged proposal goes stale when the
person edits over it (native inputs bubble their events to the Form instead).
`focusControl`, `revealControl`, `highlightControl`, and `emitControlChange`
are the same DOM helpers the built-in primitives use for their `focus`,
`reveal`, and `highlight` handles.

`controlProposalInputSchema(registry, formId)` and
`stageControlProposals(registry, formId, values)` are the transport-neutral
halves of a "propose values for this form" tool: the schema has one optional
property per proposable control (never secret/sensitive, unwritable,
disabled, read-only, file, or password controls), and staging only ever
creates reviewable proposals. smrt-svelte's `<Form webmcp>` and `FormScope`
build their `*_stage_changes` tool from these.

## Form retry

`createFormRetry()` is the browser half of `runOnce()` (`@happyvertical/smrt-core`)
for a SvelteKit enhanced form: a per-tab, per-form submission key, a refused
second submit while one is in flight, typed values kept across a validation or
transport failure, a reset after success only when the fields are unchanged
since submit, and opt-in restore after a reload (a file that cannot be restored
is reported, never silently dropped). It is framework-free and imports neither
Svelte nor SvelteKit; the submit function is typed against SvelteKit's
`SubmitFunction` shape structurally.

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import { createFormRetry } from '@happyvertical/smrt-ui/form-retry';

  const retry = createFormRetry({ form: 'report' });
</script>

<form method="POST" use:enhance={retry.enhance()} {@attach retry.attach}>
  <input name="title" />
  <button type="submit">Send</button>
  {#if $retry.status === 'transport-error'}<p role="alert">Send it again unchanged.</p>{/if}
</form>
```

With smrt-ui's own `Form`, attach the same two pieces to it (see
[Native and enhanced forms](#native-and-enhanced-forms)):
`<Form method="POST" preventDefault={false} {@attach fromAction(enhance, () => retry.enhance())} {@attach retry.attach}>`.

`/forms` re-exports the same API as the Svelte-free `/form-retry` entry. See the
[form retry guide](../../docs/content/form-retry.md) for the server half, the
per-result table, storage and private-window behaviour, and restore.

## Camera and signature capture

`CameraCapture` takes a photo from the device camera and `SignaturePad` takes a
signature, each inside an ordinary form. Both live in `/forms`, need only
browser APIs, and post their file through a plain multipart form when given a
`name`; the page wires no hidden input and no submit handler.

```svelte
<script lang="ts">
  import { CameraCapture, SignaturePad } from '@happyvertical/smrt-ui/forms';
</script>

<form method="POST" enctype="multipart/form-data">
  <CameraCapture name="photo" facingMode="environment" />
  <SignaturePad name="signature" stylusOnly={settings.signatureStylusOnly} />
  <button type="submit">Send</button>
</form>
```

**CameraCapture** uses `getUserMedia` with a live preview. The user takes a
photo, reviews it, and can retake it before "Use photo" commits it. Committing
calls `onCapture({ blob, dataUrl })` and fills the named field (`photo.jpg` by
default; set `fileName`, `imageType`, and `quality` to change it). "Retake"
after a commit empties the field and calls `onClear`. The root's `data-state`
is one of `starting`, `streaming`, `reviewing`, `committed`, `off` (disabled),
`permission-denied`, `no-camera`, `unsupported`, `error`, or `fallback`. Each
problem state has its own copy and, where it can help, a "Try again" action.
`getUserMedia` exists only in a secure context, so a page served over plain
HTTP renders `unsupported`.

The stream's tracks are stopped on unmount, when `disabled` turns on, when
`facingMode` changes (the camera is then requested again), and as soon as a
frame is captured. A permission prompt answered after unmount or disable is
discarded and its stream released. The lifecycle lives in the framework-free
`createCameraSession()` (exported with `classifyGetUserMediaError()` and
`isCameraApiSupported()`), so it can be tested against a fake `MediaDevices`.

`fileInputFallback` is opt-in and off by default. With it on, browsers without
`getUserMedia` render an `<input type="file" accept="image/*" capture>` that
carries `name` itself (`disabled` blocks it with `aria-disabled` rather than
the native attribute, so a committed photo keeps posting). It opens the
operating system's picker, which has no
live preview and can offer the gallery, so it is not a substitute for the
camera flow. With it off, those browsers render the `unsupported` state.

**SignaturePad** draws on its own canvas. "Use signature" stays disabled until
an accepted stroke exists, then returns a PNG through `onCapture({ blob,
dataUrl })` and fills the named field (`signature.png` by default). A committed
pad is locked until "Clear", which empties the field and calls `onClear`.
`stylusOnly` is a prop the caller resolves; with it on, only `pointerType ===
'pen'` draws. `isAcceptedPointerType()` and `mapPointerToCanvasPoint()` are
exported as pure functions. The pad is dark ink on white paper in every theme
and colour scheme, and the exported PNG is opaque white, so it reads the same
wherever it is shown.

**Native form posting.** The named field is a hidden `<input type="file">`
filled through `DataTransfer` (Chrome 60+, Firefox 62+, Safari 14.1+). Where
`DataTransfer` cannot be constructed or assigned, the field drops its `name`
and a capture-phase `formdata` listener appends the file while the browser
builds the request, which covers native navigation submits as well as
`new FormData(form)`. Where neither API exists, nothing is posted and
`onCapture` is the only channel. The root's `data-smrt-file-field` attribute
reports `data-transfer`, `formdata-event`, `file-input`, or `none`. Before a
commit the field posts what an empty native file input posts. `disabled`
freezes the controls but keeps a committed file in the submission; unmount the
component to drop it, or put it in a disabled `<fieldset>`, which leaves the
field out of the submission (committed or empty) in every posting strategy.

A reset of the owning form (`form.reset()`, a reset button, or SvelteKit
`enhance`'s `update()` after a success, including `createFormRetry()`'s
conditional reset) empties the field as it empties a native file input, in
every posting strategy. A committed photo or signature is discarded as
"Retake" or "Clear" would and `onClear` is called. A photo under review or
ink not yet committed is discarded too, without `onClear`, so the next entry
cannot attach the previous one's capture. `CameraCapture` returns to the live
camera (`off` while `disabled`, the emptied picker with `fileInputFallback`)
and supersedes a frame still encoding; with nothing held, a reset changes
nothing and never re-prompts for the camera. `SignaturePad` returns to blank,
unlocked paper. A reset clears both even while `disabled`, as it clears a
disabled native input, and a reset a later listener cancels still leaves the
component and the posted field both empty.

Text comes from the `ui.camera_capture.*` and `ui.signature_pad.*` i18n keys
and can be overridden per instance with `labels`. Capture is a touch flow, so
its actions (and the fallback picker) are touch targets at every density: at
least `--smrt-touch-target-min` (48px by default; see
[Touch density](#touch-density)), which ThemeProvider `overrides` can raise.
Both register with an enclosing `Form`'s interaction registry as non-readable,
non-writable `file` controls.

## DataTable controller

`DataTable` can share one headless `DataTableController` between rendered
controls and a programmatic adapter. Search, declarative filters, ordered
multi-column sorting, pagination, columns, selection, and expansion all become
plain-data commands; a header click and `controller.dispatch()` take the same
transition path.

```svelte
<script lang="ts">
  import {
    createDataTableController,
    DataTable,
    type DataTableColumn,
  } from '@happyvertical/smrt-ui/data';

  const controller = createDataTableController({
    columnIds: ['name', 'status'],
    initialState: {
      pageSize: 25,
      sorting: [{ columnId: 'name', direction: 'asc' }],
    },
  });

  controller.dispatch({
    type: 'setFilters',
    filters: [{ columnId: 'status', operator: 'equals', value: 'active' }],
  });
</script>

<DataTable {controller} data={rows} {columns} rowKey="id" sortable selectable />
```

`controller.snapshot()` returns the canonical JSON-safe version-3 `{ version,
modes, state }` envelope. `hydrateDataTableSnapshot()` accepts versions 1, 2,
and 3 and normalizes them to version 3. The envelope contains no rows, callbacks, snippets,
storage handles, tenant/principal data, query objects, or authority. URL and
saved-view adapters remain application-owned: persist the snapshot (normally
excluding selection and expansion IDs), validate it with
`hydrateDataTableSnapshot`, and feed the state into a new controller or
`replaceState`. `smrt-ui` does not read or write the URL, browser storage, or a
database.

### Controlled and migration use

Pass `state` plus `onStateChange` for controlled state. A controlled controller
emits a candidate and waits for the host to call `replaceState`; an
uncontrolled controller owns the state initialized by `initialState`.

The existing Svelte bindables remain supported during migration:

| Existing prop | Controller state |
| --- | --- |
| `bind:sort` | first entry of ordered `sorting` (single-sort compatibility) |
| `bind:page`, `pageSize` | `page`, `pageSize` |
| `bind:selected`, `bind:expanded` | legacy explicit `selectedRowIds`, canonical `selection` and `expandedRowIds` |
| `visibleColumnIds` | `columnVisibility` intersected with static `column.hidden` |
| `manualSorting`, `manualPagination` | sorting/pagination entries in `modes` |
| `filterFn` | local-only legacy predicate; never serialized |

An explicit `controller` takes precedence over `state` and legacy bindables.
Without one, the component creates an internal controller and maps the legacy
props. Multi-column sorting and persisted layouts use the controller state;
the legacy `SortState` remains intentionally single-column.

### Public surface and supported combinations

`DataTable` supports the following contracts. These are intentionally composed
through the controller rather than through a separate report or remote-table
component.

| Need | Public API | Important constraint |
| --- | --- | --- |
| Stable row interaction | `rowKey`, `selectable`, `expanded`, `onRowClick`, `agentAddressable` | `rowKey` is mandatory whenever a row has durable or remote identity. |
| Declarative view state | `controller`, `state`, `initialState`, `onStateChange` | A supplied `controller` wins over controlled state and legacy bindables. |
| Local or remote transformations | `modes`, `manualSorting`, `manualPagination`, `filterFn`, `totalRows` | A manual stage never runs locally; never mix a local transform with an already transformed remote result. |
| Query lifecycle | `loading`, `refreshing`, `stale`, `partialResults`, `error`, `onRetry` | The caller owns request cancellation and revision checks; the table only presents the supplied result state. |
| Report layout | column `headerPath`, `resizable`, `role`, `responsive`; `structuralRows`; controller widths/pinning | Group structure follows final visible leaf columns. Structural rows are never selectable or virtualized. |
| Narrow screens | `visibleColumnIds` and responsive column metadata | The table preserves its semantic columns behind a named, keyboard-scrollable horizontal overflow region; it does not silently collapse content. |
| Continuous browsing | `virtualization` | Requires `rowKey` and a fixed-height body. Expanded rows deliberately use the normal semantic body. |

The interactive workbench's **Data Table** entry contains a release conformance
fixture for each row in this table: local interaction, manual query lifecycle,
responsive overflow, report layout, and virtualization.

### Row identity and selection

`rowKey` is required for selectable, expandable, manual/server, and
`agentAddressable` tables. Its values must be unique non-empty strings or finite
numbers. This fails closed before a renderer can reuse the wrong row after a
sort, refresh, or server-page change. The historical source-index fallback
exists only for local presentational tables with no durable row state.

The controller stores a `selection` union alongside the deprecated
`selectedRowIds` shorthand:

| Scope | Stored value | Lifecycle |
| --- | --- | --- |
| `page` | IDs from the current rendered page | Cleared when page, page size, search, filters, or sorting changes. |
| `explicit` | Explicit stable IDs across pages | Persists across page and query navigation until changed by the caller. |
| `allMatching` | `queryFingerprint`, `queryRevision`, and `expectedCount` only | Never stores loaded IDs; query-shape changes clear it. |

The built-in header checkbox explicitly means **Select all rows on this page**.
For query-wide selection, dispatch `selectAllMatching` with the caller-owned
query fingerprint, revision, and expected count. A destructive domain action
must call `assertDataTableSelectionCurrent(selection, currentQuery)` immediately
before applying it; a mismatched fingerprint or revision throws rather than
acting on stale results.

`index` passed to row callbacks, cells, expansion snippets, and `rowClass` is
the zero-based display index on the currently rendered page. The source index
is the zero-based position in the supplied `data` array and is used only by the
non-durable fallback. It must never be saved, sent to an agent, or used as a
remote identity.

### Transformation ownership and page rules

`modes` makes each stage explicit. A `manual` stage renders caller-supplied
results and bypasses that local stage, so rows are never double-filtered,
double-sorted, or double-paged.

| Filtering | Sorting | Pagination | Renderer behavior |
| --- | --- | --- | --- |
| `local` | `local` | `local` | filter → ordered multi-sort → slice |
| `manual` | `local` | `local` | sort and slice supplied rows |
| `local` | `manual` | `local` | filter and slice supplied rows |
| `local` | `local` | `manual` | filter and sort supplied page; never slice it |
| `manual` | `manual` | `manual` | render supplied rows unchanged |

Every combination follows the same rule per column in the table: each local
stage runs once and each manual stage runs zero times. For manual pagination,
`totalRows` supplies the total; when it is unknown the component does not guess
the last page or render misleading pagination controls. A supplied `totalRows`
must be a non-negative integer and is rejected unless pagination mode is
`manual`.

Changing search, filters, sorting, or page size resets the page to 1 only when
the value changes. Data or total changes clamp an out-of-range page but do not
otherwise reset it; empty known totals normalize to page 1. Column layout,
selection, and expansion never change the page.

### Manual query, retry, and race contract

When any stage is `manual`, the host owns the request and result lifecycle. On
each query-shape change, derive a stable `queryFingerprint` from every
server-owned input (search, filters, sort rules, page, and page size) and a
monotonically increasing `queryRevision`; start the request, retain the
currently displayed rows with `refreshing`/`stale` as appropriate, and only
commit a response when both values still match. A late response is discarded by
the host, not merged by `DataTable`.

```ts
const queryFingerprint = JSON.stringify({ search, filters, sorting, page, pageSize });
const query = { queryFingerprint, queryRevision: String(revision) };
const result = await loadRows(query);

if (query.queryRevision === String(revision) && query.queryFingerprint === currentQueryFingerprint()) {
  rows = result.rows;
  totalRows = result.totalRows;
}
```

Set `error` without clearing a usable page, and make `onRetry` create a new
revision. For query-wide actions, dispatch `selectAllMatching` with the same
fingerprint/revision and call `assertDataTableSelectionCurrent` directly before
the destructive request. This gives ContentList, reporting, admin, and agent
surfaces the same stale-result and selection guardrail.

### Saved layout and report guidance

Use `headerPath` on every leaf that belongs to a grouped heading; matching IDs
at a given depth form a column group after visibility and restored column order
are applied. Keep report totals in `structuralRows` or `footer`, not in the
data array. Persist `controller.snapshot()` only after removing tenant-specific
selection and expansion IDs, then hydrate it before creating the next
controller. The version-3 snapshot includes `columnOrder`,
`columnVisibility`, `columnWidths`, and `columnPinning`, so a report can safely
restore layout without persisting row data or query authority.

### Scale boundaries and virtualization

`DATA_TABLE_SCALE_THRESHOLDS` publishes the measured operating boundaries used
by the reproducible DataTable benchmark:

| Work | Boundary | Use after the boundary |
| --- | --- | --- |
| Ordinary local rendering | 250 rows / 5,000 cells | Page or virtualize the body. |
| Local filtering and sorting | 1,000 rows / 20,000 cells | Move the transform to the caller or server. |
| Manual/server paging | 100 supplied rows per page | Keep `totalRows` server-owned and bounded. |

Run `pnpm --filter @happyvertical/smrt-ui bench:data-table` to measure the
250-row local render, 1,000-row client-transform, and 100-row manual-paging
fixtures. The fixture data has deterministic `rowKey` values so a browser or
renderer comparison does not depend on array-arrival identity.

`virtualization` is opt-in and requires `rowKey`. It virtualizes only a
fixed-height data body; table headers (including grouped headers) and the
`footer` summary remain normal semantic table sections and do not count toward
the window. The virtual scroll region keeps captions and headers sticky, is
keyboard-scrollable, and reports the full row count plus each rendered row's
logical row index. Supplying `expandedContent` makes data-row height variable,
so the component deliberately falls back to the full semantic body and does
not emit virtual scroll callbacks. Use controlled `scrollTop`/
`onScrollTopChange` for scroll restoration, and pair `focusedRowId` with
`onFocusedRowIdChange` to restore DOM focus to a stable row after a data
refresh. A measured footer extends the virtual scroll range, so keyboard End
and a controlled scroll position can still reveal the summary. Selection and
expansion continue to be controller state keyed by `rowKey`, never by a
rendered window index. With manual pagination, `totalRows` and the current page
set that full row count and each rendered row's global index.
## Mounted data-surface registry

`createDataSurfaceRegistry()` is the transport-neutral sibling of the form
interaction registry. A mounted table, list, or report supplies serializable
discovery metadata, a revisioned view snapshot, and a small handler for its
declared visible controls. The registry rejects duplicate identities, validates
JSON-safe data, requires an `expectedRevision`, records monotonic event
sequences, serializes commands per mounted identity, and returns a cached
acknowledgement when the same `commandId` is replayed. The replay cache retains
only the 100 most recently used command IDs per mounted surface.

Visible-command and preview/apply-action envelopes are capped at 100,000 UTF-8
bytes (`DATA_SURFACE_MAX_REQUEST_BYTES`). JSON values reject prototype keys and
have fixed nesting and container-size bounds, so every browser-facing request
remains safe to normalize before host policy evaluates it.

```ts
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';

const registry = createDataSurfaceRegistry();
let revision = 0;
let search = '';

registry.register({
  descriptor: {
    version: 1,
    identity: { surfaceId: 'content-library', kind: 'table' },
    schemaVersion: 1,
    label: 'Content library',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read', 'project'] },
      { id: 'title', label: 'Title', capabilities: ['read', 'search'] },
    ],
    query: { modes: ['rows', 'count'], projectableColumnIds: ['id', 'title'] },
    controls: [{ id: 'set-search', label: 'Search' }],
    actions: [],
    limits: { maxQueryRows: 100, maxQueryBytes: 100_000, maxSelectionSize: 100 },
  },
  getSnapshot: () => ({ revision, state: { search } }),
  execute: (command) => {
    if (command.controlId === 'set-search') {
      search = String((command.payload as { search?: string }).search ?? '');
      revision += 1;
    }
  },
});
```

### Navigation and step surfaces

Two ready-made surfaces cover interactions a view intent cannot reach on its
own (an intent only dispatches a registry command):

- `registerLinkSurface({ registry, surfaceId, label, description, links,
  navigate })` mounts a menu, tab row, or section list. `state.links`
  publishes each link's id, label, description, and group — never its href —
  and the default `open` control resolves `{ target }` (an id, a label, or a
  unique label prefix) to one of those links and calls `navigate(href)`.
  Nothing an agent sends can become a URL.
  Return the navigation's promise from `navigate`: the command answers at
  once, and `whenSurfaceNavigationSettled(registry)` resolves once it
  finished and the new page's surfaces registered (a bespoke surface that
  navigates calls `trackSurfaceNavigation(registry, promise)`).
- `registerStepSurface({ registry, surfaceId, label, description, steps,
  current, next, back, goTo, nextWrites, showNext })` mounts a wizard.
  `state` carries the steps with their status, the current step, and
  `nextWrites`. `next`/`back`/`go-to` run the page's own handlers (return
  `false` to refuse, e.g. when validation fails). When the current step's
  forward button saves or creates something (`nextWrites`), `next` never
  presses it: it calls `showNext` to reveal and highlight the button and
  publishes `awaitingPerson: true` until the flow moves on.

smrt-svelte's `useLinkSurface` / `useStepSurface` / `useListSurface`
(`@happyvertical/smrt-svelte/web`) bind these to a component's lifetime on
the Provider's registry.

`inspect()` and command results are deterministic `{ version, descriptor,
revision, state, selection }` envelopes; neither includes a timestamp, rows,
functions, authority fields, tenant/principal data, SQL, or a transport handle.
The registry rejects those boundary keys from both default and redacted snapshot
state. An optional registration `redact()` hook can remove sensitive view state
before it leaves the mounted host, but cannot alter the identity or revision.

The registry validates bounded projection/count/facet query envelopes (including
the UTF-8 byte length of their normalized JSON form) and preview/apply action
envelopes, but it does not execute either. Canonical query semantics belong to
the query protocol, browser command acknowledgement belongs to a transport
adapter, and authentication, tenancy, confirmation-token verification, and
durable actions remain server-side. URL state and saved views also remain
application-owned persistence adapters.

### DataTable and CollectionToolbar integration

Registration is opt-in. Pass `dataSurface` with an explicit descriptor and a
registry; existing `DataTable` and `CollectionToolbar` consumers do not
register or change behavior. Registration follows reactive `dataSurface` and
controller prop replacement, so registry commands never retain a prior mounted
instance. A DataTable descriptor must only name effective, visible columns,
except for its stable `rowKey`, which may remain non-rendered. Mounted tables
always require that `rowKey` to be an explicit string field; the index fallback
and functional key callbacks are never addressable across pages or refreshes.

```svelte
<script lang="ts">
  import { DataTable, createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';

  const registry = createDataSurfaceRegistry();
  const dataSurface = {
    registry,
    descriptor: {
      // descriptor omitted: give this mounted instance a stable identity,
      // policy-visible columns, controls, query limits, and action descriptors
    },
  };
</script>

<DataTable {dataSurface} data={rows} {columns} rowKey="id" />
```

Declared controller controls include search, filters, multi-sort, page/page
size, column layout, selection, expansion, reset, focus/reveal/highlight, and
optional refresh/retry callbacks. The component maps controller controls to the
same `DataTableController.dispatch()` path used by buttons and checkboxes. A
controlled table supplies `applyControlledState(candidate, command)`; the
registry acknowledges only after that callback settles the candidate state.

`CollectionToolbar` accepts the same opt-in registration and an optional
`controller`. Its `set-search` control shares that table controller; `set-view`
remains toolbar-local. Descriptors may advertise row/bulk action contracts, but
smrt-ui does not execute durable actions—the later authenticated action adapter
owns preview, confirmation, authorization, and persistence.

Toolbar snapshots also advance their revision when the host updates exposed
uncontrolled `search` or `view` props, so a command based on an earlier view is
rejected as stale instead of overwriting host state.

DataSurface columns may also carry domain-neutral policy metadata (`fieldName`,
`visibility`, `order`, `role`, `responsivePriority`, `readable`, and per-column
operator allowlists). Domain packages such as `@happyvertical/smrt-fields`
apply their effective policy above this package; `smrt-ui` validates and
serializes the metadata without owning field authorization or policy rules.

## Themes

`@happyvertical/smrt-ui/themes` is the canonical theme API and includes the
Material, Glass, Studio, s-m-r-t, and HappyVertical ("Day Shift") presets. The
old `/theme` path forwards to the same provider and context for compatibility.

Day Shift is the HappyVertical brand identity: a calm instrument panel with an
enamel ground, faceplate panels on hairline bezels, and a single amber accent
that also serves as the focus ring. Both its light and dark schemes are
hand-authored, and every text pairing clears WCAG AA.

```svelte
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/base.css';
  import '@happyvertical/smrt-ui/themes/styles/all.css';
  import '@happyvertical/smrt-ui/themes/styles/fonts.css';
</script>

<ThemeProvider preset="smrt" colorScheme="dark">
  {@render children()}
</ThemeProvider>
```

The application baseline is intentionally separate from theme tokens. Import
`base.css` once at the app entry point to remove the browser body margin, use
border-box sizing, apply the active theme to the document, and make native form
controls inherit the app typeface. It does not reset lists or content margins.

PageLayout keeps wide tables and tab rows within the available page width,
including when nested inside a semantic section. Their own scroll containers
remain scrollable. Place visual sections directly under PageLayout to use its
vertical gap.

Use `PageLayout` inside an application shell to give each route responsive
gutters, block padding, vertical rhythm, and the width appropriate to its
content. It never creates a scroll container or claims viewport height.
Use `ActionGroup` for adjacent page or card actions; it wraps with token spacing
and can justify actions at the start or end without form-specific behavior.

```svelte
<script>
  import { PageHeader, PageLayout } from '@happyvertical/smrt-ui/layout';
</script>

<PageLayout maxWidth="xl" gap="md">
  <PageHeader title="Projects" subtitle="Plan and track active work" />
  <!-- collection, cards, form, or detail content -->
</PageLayout>
```

Run the shared playground to inspect the full catalog under every preset and
light/dark scheme.

### Card look tokens

`Card` and `CollectionList` rows read these custom properties, so an app can
change the card look once in its own theme layer instead of per page. Unset,
they keep the stock look.

| Property | Default | Used for |
| --- | --- | --- |
| `--smrt-card-border` | `1px solid var(--smrt-color-outline-variant)` | edge of `default` and `elevated` cards, CollectionList rows |
| `--smrt-card-background` | `var(--smrt-color-surface)` | card and row fill |
| `--smrt-card-shadow` | `none` | shadow of `default` cards (`elevated` keeps its elevation) |
| `--smrt-card-divider` | `1px solid var(--smrt-color-outline-variant)` | rule under a card header / above its footer |

The `outlined` variant always draws its outline. For borderless cards on a
`surface` page, pair `--smrt-card-border: none` with a tinted background such
as `var(--smrt-color-surface-variant)` so cards stay distinct in both schemes:

```css
:root {
  --smrt-card-border: none;
  --smrt-card-background: var(--smrt-color-surface-variant);
}
```

### Component override hooks

Hooks an app sets once in its own theme layer instead of restyling a component's
classes. Unset, each keeps its stock look.

| Property | Component | Used for |
| --- | --- | --- |
| `--smrt-popover-panel-width` | `Popover` | the panel's width (never wider than the viewport minus 2rem) |
| `--smrt-popover-panel-padding` | `Popover` | the panel's padding |
| `--smrt-admin-shell-background` | `AdminShell` (smrt-svelte) | the page background behind the cards |
| `--smrt-admin-shell-scrollbar-track` / `-thumb` / `-thumb-hover` | `AdminShell` (smrt-svelte) | the themed thin scrollbars inside the shell |
| `--smrt-shell-title-font-family` | `ShellTitle` (smrt-svelte) | the workspace name's font family |

`IconToggle` takes a `tone` prop (a CSS colour such as `var(--status-draft)`) for
a toggle that is neutral until pressed and then wears its colour.

## Development

```bash
pnpm check
pnpm test
pnpm build
pnpm verify:pack
```

### Touch density

Set `<ThemeProvider density="touch">` for floor tablets and phones, or set
`density="touch"` on Input, Select, Textarea, Checkbox, Switch, RadioGroup,
Button (including links), FilterChips, SegmentedControl, or DataTable. DataTable
applies density to its sort buttons. Density is independent of existing `size`
props, including native Input/Select sizes. Omitted density inherits; explicitly
setting `density="comfortable"` opts that control out and keeps its usual size.
RadioGroup expands each option's clickable label, and Checkbox/Switch expand
the label hit area while preserving the visual mark.

`--smrt-touch-target-min` defaults to `48px` across all presets and works without
a provider. Customize it globally with ThemeProvider's `overrides`, for example
`overrides={{ '--smrt-touch-target-min': '56px' }}`. Touch targets grow with larger
content; normal density keeps existing component sizing. `CameraCapture` and
`SignaturePad` actions use `--smrt-touch-target-min` at every density, since
capture is a touch flow. TenantNav sizing is
tracked separately in [#3246](https://github.com/happyvertical/smrt/issues/3246).

### Narrow DataTable

Set `responsiveMode="hide-columns"` to adapt to the table's container width.
The default `responsiveBreakpoint={800}` includes both 768px tablets and 390px
phones. Narrow mode budgets one column per `responsiveColumnMinWidth={160}`
pixels, after reserving space for selection and expansion controls. Higher
`column.responsive.priority` values survive first (missing/nonfinite values are
zero); ties preserve declared display order. `responsive.keepVisible` columns
always survive responsive collapse, while explicitly hidden columns stay hidden.

Retained cells wrap, and their desktop width and pinning settings resume when
the container widens. Responsive presentation never changes controller state,
sorting, selection, or persisted column visibility. Header groups and structural
row colspans follow the retained columns. If keepVisible columns exceed the
budget, all remain visible and share the available width. Custom cell/header
snippets should fit their cells. Default `responsiveMode="scroll"` preserves
existing horizontal scrolling.

ConfirmDialog opens a native modal dialog above existing Modal and Drawer surfaces.
Its `message` accepts plain text or a Svelte snippet (including lists and emphasis);
each instance owns its accessible title and description ids. Escape and backdrop
clicks request `oncancel`; the parent controls `open`. The opener regains focus
on close. Buttons remain disabled while `loading`, and Escape stays available.
The native top layer replaces the previous fixed div; confirmation now stacks
above an already open modal and makes its background inert. Escape is scoped to
the active dialog rather than handled globally. Existing `open`, `loading` and
action callbacks retain their controlled-state contracts.

Browser feedback contracts run with `pnpm --filter @happyvertical/smrt-ui test:e2e`
(after installing Playwright Chromium, or setting
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a local Chromium executable).

ToastViewport follows the topmost native modal dialog and restores its original
host when all modals close. Its live region, dismiss buttons and actions stay
interactive inside Modal, Drawer and ConfirmDialog. Hover and focus independently
pause auto-dismiss, then resume the remaining duration. Configure
`createToaster({ successDuration: 0 })` to keep success records until dismissal;
per-toast `duration: 0` remains supported. `inset` accepts a CSS length, `anchor`
accepts a content-region element, and `top-center`/`bottom-center` positions center
the viewport within that region (or the window). Anchor geometry follows resize
and scroll. Custom injected Toaster implementations may optionally implement
`pause(id, reason)` and `resume(id, reason)` to support interaction pausing.

### SegmentedControl forms

SegmentedControl renders native radio inputs. Set `name` to post the selected
option value with ordinary form submission or FormData; numeric values post as
strings while bound values retain their declared type. Unselected, unknown,
disabled-option, disabled-control and disabled-fieldset values are omitted.
`required` uses native form validation and accepts numeric zero. Nameless controls
validate without posting a generated field. Arrow keys cycle enabled options;
Home/End select the first/last enabled option. Touch density applies to the full
clickable segment.

Native form reset restores the initial bound value if that option is still
available and enabled; otherwise it clears the selection. Canceling the reset
event preserves the current selection. Reset does not fire `onvaluechange`,
matching native controls; bind:value reflects it.

### Application icons

Icon includes the original menu/search/chevron/action glyphs plus `alert`,
`warning`, `info`, `home`, `user`, `settings`, `trash`, `edit`, `calendar`,
`clock`, `camera`, `upload`, and `download`. Import `registerIcons` from
`@happyvertical/smrt-ui` to install an application SVG path map at startup.
Registrations update mounted icons; the returned cleanup function removes that
registration and restores the previous active set. Last active registration wins,
and an explicit Icon `path` prop wins over every named set. Unknown names retain
their empty shape. Names and paths must be nonempty strings; invalid mixed sets
are rejected atomically. Sets are snapshotted, so later caller mutations do not
change glyphs. Register static application assets, never request or identity data,
and install the same application set for SSR and client hydration.

### Currency, country, and province controls

Import `CurrencySelect`, `CountrySelect`, `ProvinceSelect`, their named `*Props`
interfaces, and `CodeSelectOption` from `@happyvertical/smrt-ui/forms`. Each composes
shared Select/Input controls, accepts a bindable string `value`, native Select
attributes (except children/multiple), density and interaction configuration,
`locale` (default `en`), `placeholder` (default `—`), and `readOnly`.

Currency choices use existing ISO 4217 metadata. Countries cover 249 ISO 3166-1
alpha-2 codes; both use Intl.DisplayNames and invalid locales fall back to English.
ProvinceSelect accepts `country?: string`: built-ins cover Canada's 13 subdivisions
and the United States' 57 ISO subdivisions (50 states, DC and six territories).
Region labels default to English. Other/missing countries use a free-text Input.
Provide `options?: readonly CodeSelectOption[]` to replace built-ins and localize
region labels; even an empty array deliberately selects the custom Select mode.
Each option has `value`, optional `label`, and optional `disabled`.

Blank values stay blank; unknown values and country/options changes preserve the
exact raw string. Callers validate permitted values server-side. Disabled options
retain native FormData omission. `readOnly` disables the visible control and submits
the original value via a hidden input, including external `form` association;
`disabled` and disabled fieldsets omit it. Province event targets can be either
HTMLInputElement or HTMLSelectElement. All controls expose `focus()` and
`getElement()`. The Workbench code-selectors entry demonstrates changing countries
and inspecting native payloads without a provider.
