---
'@happyvertical/smrt-svelte': minor
---

Earlier QA-branch additions to smrt-svelte:

- Responsive `AdminShell` chrome, all opt-in: a full-width `header`,
  `phoneTopBar` (hides on scroll), `phoneBottomBar` (replaced by a form's
  `FormActionBar`), overlays, scrim and swipe-to-close, resizable edges, and
  `ShellState.viewport`. `keepMounted` edges keep their panel mounted (hidden)
  while collapsed; `ShellNavItem.attention` shows an announced dot.
  `overlayMedia` slides a side edge over the page below a media query (inert
  page, focus in and back, Escape or scrim closes, slides back out on close);
  `shell.presentationFor(edge)`. A closed phone drawer is inert, the header lets
  menus drop below it, a panel resize ends on lost capture or unmount, and the
  page trail shows an ancestor once.
- `useListSurface`, `useLinkSurface`, `useStepSurface`: one-call data-surface
  hooks for a rendered list (with a text `find` control), a menu or tab row,
  and a wizard.
- The rich `Form` spreads native form attributes, takes SvelteKit's `enhance`,
  and its `<formId>_stage_changes` tool stages smrt-ui primitives and
  `useControlRegistration` composites too; `FormScope` offers the same around
  content without a `<form>`.
- `tryUseWebMcpUi()`: the Provider's mounted-UI registries, or `null` instead of
  a throw.
- WebMCP: only branded proposal tools (view intents and the UI adapter's own
  tools) auto-run in the assistant dock; a bespoke tool can no longer claim the
  `intent` owner label to skip confirmation.
