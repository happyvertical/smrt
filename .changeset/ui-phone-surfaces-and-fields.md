---
'@happyvertical/smrt-ui': minor
---

Earlier QA-branch additions to smrt-ui:

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
