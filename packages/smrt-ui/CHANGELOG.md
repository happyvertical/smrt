# @happyvertical/smrt-ui

## 0.55.8

### Patch Changes

- @happyvertical/smrt-types@0.55.8

## 0.55.7

### Patch Changes

- @happyvertical/smrt-types@0.55.7

## 0.55.6

### Patch Changes

- @happyvertical/smrt-types@0.55.6

## 0.55.5

### Patch Changes

- @happyvertical/smrt-types@0.55.5

## 0.55.4

### Patch Changes

- @happyvertical/smrt-types@0.55.4

## 0.55.3

### Patch Changes

- @happyvertical/smrt-types@0.55.3

## 0.55.2

### Patch Changes

- @happyvertical/smrt-types@0.55.2

## 0.55.1

### Patch Changes

- @happyvertical/smrt-types@0.55.1

## 0.55.0

### Patch Changes

- @happyvertical/smrt-types@0.55.0

## 0.54.4

### Patch Changes

- @happyvertical/smrt-types@0.54.4

## 0.54.3

### Patch Changes

- @happyvertical/smrt-types@0.54.3

## 0.54.2

### Patch Changes

- @happyvertical/smrt-types@0.54.2

## 0.54.1

### Patch Changes

- @happyvertical/smrt-types@0.54.1

## 0.54.0

### Patch Changes

- @happyvertical/smrt-types@0.54.0

## 0.53.6

### Patch Changes

- @happyvertical/smrt-types@0.53.6

## 0.53.5

### Patch Changes

- @happyvertical/smrt-types@0.53.5

## 0.53.4

### Patch Changes

- @happyvertical/smrt-types@0.53.4

## 0.53.3

### Patch Changes

- @happyvertical/smrt-types@0.53.3

## 0.53.2

### Patch Changes

- @happyvertical/smrt-types@0.53.2

## 0.53.1

### Patch Changes

- @happyvertical/smrt-types@0.53.1

## 0.53.0

### Patch Changes

- @happyvertical/smrt-types@0.53.0

## 0.52.0

### Minor Changes

- 0259083: An agent never moves the person's keyboard focus. A `focus` command from
  `source: 'agent'` on the control-interaction registry now reveals and
  highlights the control instead of focusing it; a user-sourced `focus` is
  unchanged. The `smrt_ui_execute_form_control` tool description says so.
- 0259083: Cards are themeable: `Card` and `CollectionList` rows read `--smrt-card-border`,
  `--smrt-card-background`, `--smrt-card-shadow` and `--smrt-card-divider`, so an
  app can make its cards borderless (or tinted, or shadowed) once in its theme
  layer. Unset, the stock look is unchanged; the `outlined` variant always keeps
  its outline.
- 0259083: `Checkbox`, `Radio` and `Switch` get an invisible 44x44px hit area by default.
  The visible box is unchanged (about 18px) and no layout shifts: a transparent
  `::before` on the wrapping label enlarges the clickable region. The box and
  label text sit above every hit area, so one control's hit area never takes a
  click from another control's box or text.
  
  The hit area paints above plain content around it, so it is constrained:
  
  - A `Checkbox` or `Radio` beside other content in its parent (a row title, a
    link, a group's other options) grows vertically only, in the box's own
    column; only a control that stands alone gets the full 44x44. Content
    directly above or below a box, closer than 13px, is still covered: give it
    room or shrink the area.
  - In table cells the area never leaves the cell; a `Checkbox` that is the
    cell's only content fills the cell. The cell is given `position: relative`
    at zero specificity, so sticky headers and pinned columns keep their own
    positioning.
  
  Set `--smrt-control-hit-size` to resize it (`0px` turns it off).
- 0259083: Dictation records when the browser cannot recognise speech. Give `Dictation`
  a `transcribe(audio, { mimeType, language, durationMs, signal })` function
  (new `createHttpTranscriber(url)` posts the raw audio to your own server
  route and reads `{ text }`). When there is no speech source or no Web Speech
  API (Firefox), or the recogniser fails with `network` /
  `service-not-allowed` / ends straight away before hearing anything (Brave),
  it records the message with `MediaRecorder` instead (WebM/Opus, MP4 on
  Safari; `maxDurationMs` default 2 minutes, after which it is written down,
  and `maxBytes` default 10 MB, past which it fails as too long). Stopping
  moves to the new `transcribing` state ("Writing it down…" in
  `DictationStatus`; the microphone is busy meanwhile), then the text goes in
  at the cursor. After one such failure the same `Dictation` records straight
  away. New error kinds with plain messages: `too-long`, `not-transcribed`,
  `unavailable` (not set up), `forbidden`. New `recording` flag,
  `DictationError`, `createMediaRecorderCapture` (injectable as `capture`),
  `pickDictationMimeType`, `canCaptureDictationAudio`. Log events carry
  `fallback: 'recording'` when it carried on by recording.
  
  `AssistantComposer` and `AssistantDock` take a `transcribe` prop for the
  same fallback; with only `transcribe` the microphone shows and always
  records.
  
  `stop()` stops waiting for the recorder's `stop` event after 3 seconds and returns the audio that arrived, so a browser that never fires it cannot leave the field stuck.
- 0259083: Speak into text fields. `@happyvertical/smrt-ui/forms` adds `Dictation` (the
  listening state machine over any speech source), `DictationButton` (a 44px
  microphone toggle) and `DictationStatus` (listening and plain-words errors:
  unsupported browser, blocked microphone, nothing heard), `insertTextAtCursor`,
  a Web Audio "ready" beep (`playReadyBeep`, no sound files), and `longPress` /
  `createLongPress` (hold ~500ms; moving past 10px is a drag, not a long press).
  `@happyvertical/smrt-svelte/browser-ai` adds `createSttDictationSource`, which
  lends `Dictation` the existing speech-to-text adapters (browser speech by
  default), created lazily on first use.
  
  `DictationStatus` takes no room while it has nothing to say.
- 0259083: One sorting contract for lists. `@happyvertical/smrt-ui/data` adds `list-sort`
  helpers (`parseListSort`, `toggleListSort`, `listSortSearchParams`/`listSortHref`
  for `?sort=&dir=` URL state, `listSortAria`, `sortListRows`, and an allow-listed
  `listSortOrderBy` for server queries), a `SortableHeader` for hand-rolled tables
  (link or button, `aria-sort`, arrow indicator), and a `ListSortSelect` "Sort by"
  picker for card lists. `DataTable` columns take `sortFirstDirection` (e.g. dates
  start newest first) and the table takes `sortClearable={false}` to toggle asc ⇄ desc
  without clearing. `useListSurface` publishes the list's `sort`, declares `sortable`
  columns, and accepts a `set-sorting` command through the page's own `onSort`.
  
  `createUrlListSort` / `createLocalListSort` give a page one reactive sort state
  (`sort`, `href(column)`, `toggle`, `set`) that `SortableHeader list={...}` and
  `ListSortSelect list={...}` bind to directly; the URL variant takes the router's
  current URL and navigate function, so it works in any SvelteKit package.
- 0259083: `IconToggle` (`@happyvertical/smrt-ui/ui`): an icon-only toggle button for dense filter rows and view switchers. The icon is a snippet in any icon set; `label` is the accessible name and tooltip, `pressed` is `aria-pressed`, an optional `count` badge joins the name and tooltip, and the hit area is at least 44px. `CollectionList` gains a `gallery` layout (picture-first tiles with the selection box and `actions` floating over the corners), wraps the selection checkbox in a label, and lifts the checkbox and actions above an item's stretched link so an item can be one big link.
  
  A pressed `IconToggle` is not told apart by colour alone: it also draws a 2px ring in its text colour (WCAG 1.4.1).
- 0259083: `IconToggleGroup` (`@happyvertical/smrt-ui/ui`): joins a row of `IconToggle`s into one segmented, labelled group (`role="group"`, named by `label`) with shared edges and rounded ends, so each kind of filter reads as one control. `IconToggle`'s count badge is now outlined (1px theme outline, neutral text, surface face) instead of filled with the inverse surface (near-white in dark themes), and the current `Pagination` page number uses `on-primary` instead of a fixed white.
- 0259083: `Popover` gains `triggerLabel`: the accessible name (`aria-label`) of the trigger button when it shows only an icon (via the `trigger` snippet), so an icon-only popover button reads as e.g. "3 issues" instead of an empty button.
  
  An icon trigger without `triggerLabel` falls back to `label` (`Popover` and
  `Dropdown`); a `Dropdown` icon trigger with neither logs a console warning.
  The `Popover` icon trigger keeps the standard primary focus ring.
- 0259083: Navigation surfaces can be awaited. `registerLinkSurface` now tracks the
  promise its `navigate` returns on the registry (the command itself still
  answers at once, since the new page may unmount the surface), and
  `whenSurfaceNavigationSettled(registry, { quietMs, timeoutMs, alsoWatch })`
  resolves once every tracked navigation finished and the registry has been
  quiet, so the next step sees the new page's surfaces and tools. A bespoke
  surface whose command navigates calls `trackSurfaceNavigation(registry, promise)`.
  Exported from `@happyvertical/smrt-ui/data` and `/data-surface`.
- 0259083: Menus, toggles and phone sizing no longer need per-app overrides.
  
  - `Dropdown` menu items take an `icon` snippet (shown before the label, hidden from assistive technology), rows are at least 44px tall, and `variant="icon"` with `triggerLabel` gives a borderless 44px round "more" trigger in the surrounding colour.
  - `Popover` gets the same `variant="icon"` trigger, a panel clamped to the viewport width, and `--smrt-popover-panel-width` / `--smrt-popover-panel-padding` hooks.
  - `IconToggle` takes a `tone` (a CSS colour): the glyph stays neutral until pressed, then wears the tone with a soft wash and a ring, in light and dark.
  - On phones (48rem and under) every `Button` size and the `Switch` row are at least 44px tall; `TagsInput` remove buttons are 44px targets on phones and touch screens.
- 0259083: Earlier QA-branch additions to smrt-ui:
  
  - `PhoneSheet` (feedback): a non-modal full-screen page or bottom sheet that
    closes on its button, Escape or a swipe down, manages focus, and can stay
    mounted (hidden, inert) while closed. `WorkingStrip`: a transport-neutral
    working/done status strip with a polite live region, reopen and Stop.
    `FormActionBar` (forms): a form's actions, fixed to the bottom on phones
    (AdminShell hides its own phone bottom bar for it), hidden while the
    on-screen keyboard is open. `swipeDismiss` action and `swipeDismisses`.
  - `CalendarView` (`/calendar`): a generic time-zone-aware month grid with
    all-day and multi-day bands, "+N more", keyboard navigation, and a phone
    agenda; controllable month and day for URL state; a Svelte-free date model
    for server range queries. An invalid `timeZone` falls back with a console
    warning, and "today" moves at midnight. `Calendar` and `DayView` are
    deprecated.
  - `Tabs` link mode: entries with `href` render as a navigation row with
    `aria-current`, `maxVisible` moves extra tabs into a More menu (the active
    tab always stays visible), badges mark tabs needing attention, and a
    disabled link tab never fires `onchange`.
  - `PageHeader`: an editable title rendered inside its `<h1>`
    (`titleField`), a page trail from a shell context
    (`setPageHeaderContext`), crumbs and a meta line, sticky page tabs under the
    phone top bar. `backHref` is deprecated.
  - `Combobox` shows labels (never raw ids), reopens with every option, posts
    the committed id through a hidden input under `name`, and validates on it.
  - Inputs, selects and textareas use 16px text and a 44px height on phones (iOS
    no longer zooms on focus).
  - Agent-operable composites: `useControlRegistration`,
    `recordControlUserEdit`, `controlProposalInputSchema` /
    `stageControlProposals`, the control DOM helpers (`focusControl`,
    `revealControl`, `highlightControl`, `emitControlChange`), and link and step
    data surfaces (`registerLinkSurface`, `registerStepSurface`).
    `StagedControlReview` shows plain field labels, never registry ids.
- 0259083: New list pieces apps were hand-building:
  
  - `SearchInput` (`@happyvertical/smrt-ui/forms`): the search box of a list's filter bar. It searches as you type (debounced) and on Enter, reports the trimmed single-line text, follows the applied search it is given back, clears with an x, and is a 44px, 16px-on-phones field. It is a `role="search"` element, not a `<form>`, so it can sit inside a host form (Enter searches and never submits the host form).
  - `CollectionList` `layout="divided"`: a flat single column, rows separated by a hairline, a selected row shown by its checkbox. The selection checkbox is now a 44px target in every layout.
  - `DataTable` `phoneLayout="cards"`: on phones each row becomes a block of stacked cells, each cell headed by its column's name, and the column-head row is hidden visually (pair it with a `ListSortSelect`). The table keeps explicit `table`/`row`/`columnheader`/`cell` roles in this mode, so screen readers still announce the structure and each cell's column; a virtualized table keeps its own scroller.
  - `Fieldset` `stack`: lay the fields out in one column with a gap.
  - `SortableHeader` reads `--sortable-header-font-weight` (default 600; `inherit` takes the head row's weight), next to `--sortable-header-padding`.
- 0259083: `WorkingStrip` covers a supervised run: new phases `paused`, `waiting` (the
  person is needed; prominent Review button, announced assertively), `failed`
  (error colors, announced assertively) and `cancelled`, and `done` now uses
  the success colors. Every phase shows an icon and text, never color alone.
  New `floating` variant (a pill the host places over the page) shows the
  optional `status.goal` above the current step. New props: `onpause` (also
  Escape inside the strip), `onresume`, `onreview`, `ondismiss`, their labels,
  and `announceIntervalMs` (polite step announcements are throttled, 2 s
  default). Controls are 44px; the strip never takes focus by itself; reduced
  motion stops the spinner. Existing `idle | working | done` callers are
  unchanged.

### Patch Changes

- 0259083: Dictation never stops silently. Every speech error shows a plain message in
  place of "Listening" and is logged (`log` option, default `console.warn`):
  `network` and `service-not-allowed` (Brave has no speech service) say speech
  recognition isn't available in this browser; `not-allowed` says the
  microphone is blocked; `no-speech`, `audio-capture` (new `microphone` kind)
  and an unexpected `aborted` (new `interrupted` kind) each get their own
  words. A recogniser that ends by itself within `earlyEndMs` (default 1s)
  without hearing anything is an error too. On first use `Dictation` asks for
  the microphone and waits for the answer before starting the recogniser
  (`requestMicrophone`, default on). New `errorCode` (the raw code) and
  `dictationErrorCode`.
- @happyvertical/smrt-types@0.52.0

## 0.51.39

### Patch Changes

- @happyvertical/smrt-types@0.51.39

## 0.51.38

### Patch Changes

- @happyvertical/smrt-types@0.51.38

## 0.51.37

### Patch Changes

- @happyvertical/smrt-types@0.51.37

## 0.51.36

### Patch Changes

- @happyvertical/smrt-types@0.51.36

## 0.51.35

### Patch Changes

- @happyvertical/smrt-types@0.51.35

## 0.51.34

### Patch Changes

- @happyvertical/smrt-types@0.51.34

## 0.51.33

### Patch Changes

- @happyvertical/smrt-types@0.51.33

## 0.51.32

### Patch Changes

- @happyvertical/smrt-types@0.51.32

## 0.51.31

### Patch Changes

- @happyvertical/smrt-types@0.51.31

## 0.51.30

### Patch Changes

- @happyvertical/smrt-types@0.51.30

## 0.51.29

### Patch Changes

- @happyvertical/smrt-types@0.51.29

## 0.51.28

### Patch Changes

- @happyvertical/smrt-types@0.51.28

## 0.51.27

### Patch Changes

- @happyvertical/smrt-types@0.51.27

## 0.51.26

### Patch Changes

- @happyvertical/smrt-types@0.51.26

## 0.51.25

### Patch Changes

- @happyvertical/smrt-types@0.51.25

## 0.51.24

### Patch Changes

- @happyvertical/smrt-types@0.51.24

## 0.51.23

### Patch Changes

- @happyvertical/smrt-types@0.51.23

## 0.51.22

### Patch Changes

- @happyvertical/smrt-types@0.51.22

## 0.51.21

### Patch Changes

- @happyvertical/smrt-types@0.51.21

## 0.51.20

### Patch Changes

- @happyvertical/smrt-types@0.51.20

## 0.51.19

### Patch Changes

- @happyvertical/smrt-types@0.51.19

## 0.51.18

### Patch Changes

- @happyvertical/smrt-types@0.51.18

## 0.51.17

### Patch Changes

- @happyvertical/smrt-types@0.51.17

## 0.51.16

### Patch Changes

- @happyvertical/smrt-types@0.51.16

## 0.51.15

### Patch Changes

- @happyvertical/smrt-types@0.51.15

## 0.51.14

### Patch Changes

- @happyvertical/smrt-types@0.51.14

## 0.51.13

### Patch Changes

- @happyvertical/smrt-types@0.51.13

## 0.51.12

### Patch Changes

- @happyvertical/smrt-types@0.51.12

## 0.51.11

### Patch Changes

- @happyvertical/smrt-types@0.51.11

## 0.51.10

### Patch Changes

- @happyvertical/smrt-types@0.51.10

## 0.51.9

### Patch Changes

- @happyvertical/smrt-types@0.51.9

## 0.51.8

### Patch Changes

- @happyvertical/smrt-types@0.51.8

## 0.51.7

### Patch Changes

- @happyvertical/smrt-types@0.51.7

## 0.51.6

### Patch Changes

- @happyvertical/smrt-types@0.51.6

## 0.51.5

### Patch Changes

- @happyvertical/smrt-types@0.51.5

## 0.51.4

### Patch Changes

- @happyvertical/smrt-types@0.51.4

## 0.51.3

### Patch Changes

- @happyvertical/smrt-types@0.51.3

## 0.51.2

### Patch Changes

- @happyvertical/smrt-types@0.51.2

## 0.51.1

### Patch Changes

- @happyvertical/smrt-types@0.51.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.49.8

### Patch Changes

- @happyvertical/smrt-types@0.49.8

## 0.49.7

### Patch Changes

- @happyvertical/smrt-types@0.49.7

## 0.49.6

### Patch Changes

- @happyvertical/smrt-types@0.49.6

## 0.49.5

### Patch Changes

- @happyvertical/smrt-types@0.49.5

## 0.49.4

### Patch Changes

- @happyvertical/smrt-types@0.49.4

## 0.49.3

### Patch Changes

- @happyvertical/smrt-types@0.49.3

## 0.49.2

### Patch Changes

- @happyvertical/smrt-types@0.49.2

## 0.49.1

### Patch Changes

- @happyvertical/smrt-types@0.49.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.47.2

### Patch Changes

- @happyvertical/smrt-types@0.47.2

## 0.47.1

### Patch Changes

- @happyvertical/smrt-types@0.47.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.45.3

### Patch Changes

- @happyvertical/smrt-types@0.45.3

## 0.45.2

### Patch Changes

- @happyvertical/smrt-types@0.45.2

## 0.45.1

### Patch Changes

- @happyvertical/smrt-types@0.45.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.43.10

### Patch Changes

- @happyvertical/smrt-types@0.43.10

## 0.43.9

### Patch Changes

- @happyvertical/smrt-types@0.43.9

## 0.43.8

### Patch Changes

- @happyvertical/smrt-types@0.43.8

## 0.43.7

### Patch Changes

- @happyvertical/smrt-types@0.43.7

## 0.43.6

### Patch Changes

- @happyvertical/smrt-types@0.43.6

## 0.43.5

### Patch Changes

- @happyvertical/smrt-types@0.43.5

## 0.43.4

### Patch Changes

- @happyvertical/smrt-types@0.43.4

## 0.43.3

### Patch Changes

- @happyvertical/smrt-types@0.43.3

## 0.43.2

### Patch Changes

- @happyvertical/smrt-types@0.43.2

## 0.43.1

### Patch Changes

- @happyvertical/smrt-types@0.43.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.42.7

### Patch Changes

- @happyvertical/smrt-types@0.42.7

## 0.42.6

### Patch Changes

- @happyvertical/smrt-types@0.42.6

## 0.42.5

### Patch Changes

- @happyvertical/smrt-types@0.42.5

## 0.42.4

### Patch Changes

- @happyvertical/smrt-types@0.42.4

## 0.42.3

### Patch Changes

- @happyvertical/smrt-types@0.42.3

## 0.42.2

### Patch Changes

- @happyvertical/smrt-types@0.42.2

## 0.42.1

### Patch Changes

- @happyvertical/smrt-types@0.42.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.40.70

### Patch Changes

- @happyvertical/smrt-types@0.40.70

## 0.40.69

### Patch Changes

- @happyvertical/smrt-types@0.40.69

## 0.40.68

### Patch Changes

- @happyvertical/smrt-types@0.40.68

## 0.40.67

### Patch Changes

- @happyvertical/smrt-types@0.40.67

## 0.40.66

### Patch Changes

- @happyvertical/smrt-types@0.40.66

## 0.40.65

### Patch Changes

- @happyvertical/smrt-types@0.40.65

## 0.40.64

### Patch Changes

- @happyvertical/smrt-types@0.40.64

## 0.40.63

### Patch Changes

- @happyvertical/smrt-types@0.40.63

## 0.40.62

### Patch Changes

- @happyvertical/smrt-types@0.40.62

## 0.40.61

### Patch Changes

- @happyvertical/smrt-types@0.40.61

## 0.40.60

### Patch Changes

- @happyvertical/smrt-types@0.40.60

## 0.40.59

### Patch Changes

- @happyvertical/smrt-types@0.40.59

## 0.40.58

### Patch Changes

- @happyvertical/smrt-types@0.40.58

## 0.40.57

### Patch Changes

- @happyvertical/smrt-types@0.40.57

## 0.40.56

### Patch Changes

- @happyvertical/smrt-types@0.40.56

## 0.40.55

### Patch Changes

- @happyvertical/smrt-types@0.40.55

## 0.40.54

### Patch Changes

- @happyvertical/smrt-types@0.40.54

## 0.40.53

### Patch Changes

- @happyvertical/smrt-types@0.40.53

## 0.40.52

### Patch Changes

- @happyvertical/smrt-types@0.40.52

## 0.40.51

### Patch Changes

- @happyvertical/smrt-types@0.40.51

## 0.40.50

### Patch Changes

- @happyvertical/smrt-types@0.40.50

## 0.40.49

### Patch Changes

- @happyvertical/smrt-types@0.40.49

## 0.40.48

### Patch Changes

- @happyvertical/smrt-types@0.40.48

## 0.40.47

### Patch Changes

- @happyvertical/smrt-types@0.40.47

## 0.40.46

### Patch Changes

- @happyvertical/smrt-types@0.40.46

## 0.40.45

### Patch Changes

- @happyvertical/smrt-types@0.40.45

## 0.40.44

### Patch Changes

- @happyvertical/smrt-types@0.40.44

## 0.40.43

### Patch Changes

- @happyvertical/smrt-types@0.40.43

## 0.40.42

### Patch Changes

- @happyvertical/smrt-types@0.40.42

## 0.40.41

### Patch Changes

- @happyvertical/smrt-types@0.40.41

## 0.40.40

### Patch Changes

- @happyvertical/smrt-types@0.40.40

## 0.40.39

### Patch Changes

- @happyvertical/smrt-types@0.40.39

## 0.40.38

### Patch Changes

- @happyvertical/smrt-types@0.40.38

## 0.40.37

### Patch Changes

- @happyvertical/smrt-types@0.40.37

## 0.40.36

### Patch Changes

- @happyvertical/smrt-types@0.40.36

## 0.40.35

### Patch Changes

- @happyvertical/smrt-types@0.40.35

## 0.40.34

### Patch Changes

- @happyvertical/smrt-types@0.40.34

## 0.40.33

### Patch Changes

- @happyvertical/smrt-types@0.40.33

## 0.40.32

### Patch Changes

- @happyvertical/smrt-types@0.40.32

## 0.40.31

### Patch Changes

- @happyvertical/smrt-types@0.40.31

## 0.40.30

### Patch Changes

- @happyvertical/smrt-types@0.40.30

## 0.40.29

### Patch Changes

- @happyvertical/smrt-types@0.40.29

## 0.40.28

### Patch Changes

- @happyvertical/smrt-types@0.40.28

## 0.40.27

### Patch Changes

- @happyvertical/smrt-types@0.40.27

## 0.40.26

### Patch Changes

- @happyvertical/smrt-types@0.40.26

## 0.40.25

### Patch Changes

- @happyvertical/smrt-types@0.40.25

## 0.40.24

### Patch Changes

- @happyvertical/smrt-types@0.40.24

## 0.40.23

### Patch Changes

- @happyvertical/smrt-types@0.40.23

## 0.40.22

### Patch Changes

- @happyvertical/smrt-types@0.40.22

## 0.40.21

### Patch Changes

- @happyvertical/smrt-types@0.40.21

## 0.40.20

### Patch Changes

- @happyvertical/smrt-types@0.40.20

## 0.40.19

### Patch Changes

- @happyvertical/smrt-types@0.40.19

## 0.40.18

### Patch Changes

- @happyvertical/smrt-types@0.40.18

## 0.40.17

### Patch Changes

- @happyvertical/smrt-types@0.40.17

## 0.40.16

### Patch Changes

- @happyvertical/smrt-types@0.40.16

## 0.40.15

### Patch Changes

- @happyvertical/smrt-types@0.40.15

## 0.40.14

### Patch Changes

- @happyvertical/smrt-types@0.40.14

## 0.40.13

### Patch Changes

- @happyvertical/smrt-types@0.40.13

## 0.40.12

### Patch Changes

- @happyvertical/smrt-types@0.40.12

## 0.40.11

### Patch Changes

- @happyvertical/smrt-types@0.40.11

## 0.40.10

### Patch Changes

- @happyvertical/smrt-types@0.40.10

## 0.40.9

### Patch Changes

- @happyvertical/smrt-types@0.40.9

## 0.40.8

### Patch Changes

- @happyvertical/smrt-types@0.40.8

## 0.40.7

### Patch Changes

- @happyvertical/smrt-types@0.40.7

## 0.40.6

### Patch Changes

- @happyvertical/smrt-types@0.40.6

## 0.40.5

### Patch Changes

- @happyvertical/smrt-types@0.40.5

## 0.40.4

### Patch Changes

- @happyvertical/smrt-types@0.40.4

## 0.40.3

### Patch Changes

- @happyvertical/smrt-types@0.40.3

## 0.40.2

### Patch Changes

- @happyvertical/smrt-types@0.40.2

## 0.40.1

### Patch Changes

- @happyvertical/smrt-types@0.40.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.39.17

### Patch Changes

- @happyvertical/smrt-types@0.39.17

## 0.39.16

### Patch Changes

- @happyvertical/smrt-types@0.39.16

## 0.39.15

### Patch Changes

- @happyvertical/smrt-types@0.39.15

## 0.39.14

### Patch Changes

- @happyvertical/smrt-types@0.39.14

## 0.39.13

### Patch Changes

- @happyvertical/smrt-types@0.39.13

## 0.39.12

### Patch Changes

- @happyvertical/smrt-types@0.39.12

## 0.39.11

### Patch Changes

- @happyvertical/smrt-types@0.39.11

## 0.39.10

### Patch Changes

- @happyvertical/smrt-types@0.39.10

## 0.39.9

### Patch Changes

- @happyvertical/smrt-types@0.39.9

## 0.39.8

### Patch Changes

- @happyvertical/smrt-types@0.39.8

## 0.39.7

### Patch Changes

- @happyvertical/smrt-types@0.39.7

## 0.39.6

### Patch Changes

- @happyvertical/smrt-types@0.39.6

## 0.39.5

### Patch Changes

- @happyvertical/smrt-types@0.39.5

## 0.39.4

### Patch Changes

- @happyvertical/smrt-types@0.39.4

## 0.39.3

### Patch Changes

- @happyvertical/smrt-types@0.39.3

## 0.39.2

### Patch Changes

- @happyvertical/smrt-types@0.39.2

## 0.39.1

### Patch Changes

- @happyvertical/smrt-types@0.39.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.38.26

### Patch Changes

- @happyvertical/smrt-types@0.38.26

## 0.38.25

### Patch Changes

- @happyvertical/smrt-types@0.38.25

## 0.38.24

### Patch Changes

- @happyvertical/smrt-types@0.38.24

## 0.38.23

### Patch Changes

- @happyvertical/smrt-types@0.38.23

## 0.38.22

### Patch Changes

- @happyvertical/smrt-types@0.38.22

## 0.38.21

### Patch Changes

- @happyvertical/smrt-types@0.38.21

## 0.38.20

### Patch Changes

- @happyvertical/smrt-types@0.38.20

## 0.38.19

### Patch Changes

- @happyvertical/smrt-types@0.38.19

## 0.38.18

### Patch Changes

- @happyvertical/smrt-types@0.38.18

## 0.38.17

### Patch Changes

- @happyvertical/smrt-types@0.38.17

## 0.38.16

### Patch Changes

- @happyvertical/smrt-types@0.38.16

## 0.38.15

### Patch Changes

- @happyvertical/smrt-types@0.38.15

## 0.38.14

### Patch Changes

- @happyvertical/smrt-types@0.38.14

## 0.38.13

### Patch Changes

- @happyvertical/smrt-types@0.38.13

## 0.38.12

### Patch Changes

- @happyvertical/smrt-types@0.38.12

## 0.38.11

### Patch Changes

- @happyvertical/smrt-types@0.38.11

## 0.38.10

### Patch Changes

- @happyvertical/smrt-types@0.38.10

## 0.38.9

### Patch Changes

- @happyvertical/smrt-types@0.38.9

## 0.38.8

### Patch Changes

- @happyvertical/smrt-types@0.38.8

## 0.38.7

### Patch Changes

- @happyvertical/smrt-types@0.38.7

## 0.38.6

### Patch Changes

- @happyvertical/smrt-types@0.38.6

## 0.38.5

### Patch Changes

- @happyvertical/smrt-types@0.38.5

## 0.38.4

### Patch Changes

- @happyvertical/smrt-types@0.38.4

## 0.38.3

### Patch Changes

- @happyvertical/smrt-types@0.38.3

## 0.38.2

### Patch Changes

- @happyvertical/smrt-types@0.38.2

## 0.38.1

### Patch Changes

- @happyvertical/smrt-types@0.38.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.37.11

### Patch Changes

- @happyvertical/smrt-types@0.37.11

## 0.37.10

### Patch Changes

- @happyvertical/smrt-types@0.37.10

## 0.37.9

### Patch Changes

- @happyvertical/smrt-types@0.37.9

## 0.37.8

### Patch Changes

- @happyvertical/smrt-types@0.37.8

## 0.37.7

### Patch Changes

- @happyvertical/smrt-types@0.37.7

## 0.37.6

### Patch Changes

- @happyvertical/smrt-types@0.37.6

## 0.37.5

### Patch Changes

- @happyvertical/smrt-types@0.37.5

## 0.37.4

### Patch Changes

- @happyvertical/smrt-types@0.37.4

## 0.37.3

### Patch Changes

- @happyvertical/smrt-types@0.37.3

## 0.37.2

### Patch Changes

- @happyvertical/smrt-types@0.37.2

## 0.37.1

### Patch Changes

- @happyvertical/smrt-types@0.37.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.36.8

### Patch Changes

- @happyvertical/smrt-types@0.36.8

## 0.36.7

### Patch Changes

- @happyvertical/smrt-types@0.36.7

## 0.36.6

### Patch Changes

- @happyvertical/smrt-types@0.36.6

## 0.36.5

### Patch Changes

- @happyvertical/smrt-types@0.36.5

## 0.36.4

### Patch Changes

- @happyvertical/smrt-types@0.36.4

## 0.36.3

### Patch Changes

- @happyvertical/smrt-types@0.36.3

## 0.36.2

### Patch Changes

- @happyvertical/smrt-types@0.36.2

## 0.36.1

### Patch Changes

- @happyvertical/smrt-types@0.36.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.35.4

### Patch Changes

- @happyvertical/smrt-types@0.35.4

## 0.35.3

### Patch Changes

- @happyvertical/smrt-types@0.35.3

## 0.35.2

### Patch Changes

- @happyvertical/smrt-types@0.35.2

## 0.35.1

### Patch Changes

- @happyvertical/smrt-types@0.35.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.34.8

### Patch Changes

- @happyvertical/smrt-types@0.34.8

## 0.34.7

### Patch Changes

- @happyvertical/smrt-types@0.34.7

## 0.34.6

### Patch Changes

- @happyvertical/smrt-types@0.34.6

## 0.34.5

### Patch Changes

- @happyvertical/smrt-types@0.34.5

## 0.34.4

### Patch Changes

- @happyvertical/smrt-types@0.34.4

## 0.34.3

### Patch Changes

- @happyvertical/smrt-types@0.34.3

## 0.34.2

### Patch Changes

- @happyvertical/smrt-types@0.34.2

## 0.34.1

### Patch Changes

- @happyvertical/smrt-types@0.34.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.32.1

### Patch Changes

- @happyvertical/smrt-types@0.32.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 0.31.1

### Patch Changes

- @happyvertical/smrt-types@0.31.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- @happyvertical/smrt-types@1.0.0
