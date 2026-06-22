# @happyvertical/smrt-ui

Domain-agnostic Svelte 5 UI runtime for SMRT. This is the **leaf** of the
Svelte stack: it depends only on `svelte` (peer) and `@happyvertical/smrt-types`
— no smrt domain package — so domain packages (assets, commerce, content, …)
can consume UI primitives, i18n, the theme system, and the module UI registry
**without** taking a dependency on the top-level `@happyvertical/smrt-svelte`
integration layer. Extracting this leaf is what breaks the domain ⇄ smrt-svelte
peer cycle (see happyvertical/smrt#1582).

## What lives here

| Subpath | Contents |
|---------|----------|
| `.` | barrel re-exporting the primitives, registry, and theme system |
| `./ui` | `Button`, `Card`, `Badge`, `Avatar`, `Chip`, `Skeleton`, `Tooltip`, `Dropdown`, `Tree`, `Pagination`, … |
| `./feedback` | `Modal`, `ConfirmDialog`, `LoadingOverlay`, `ProgressBar` |
| `./layout` | `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState`, … |
| `./calendar` | `Calendar`, `DayView` |
| `./chat` | `MessageBubble`, `ReactionPicker`, `TypingIndicator` |
| `./i18n` | i18n **client**: `useI18n`, `<Trans>`, `defineMessages`, `renderTemplate` (no `smrt-languages` import — the server resolver stays in `smrt-svelte/i18n/server`) |
| `./registry` | `ModuleUIRegistry` for cross-package component discovery |
| `./theme` | simple `ThemeProvider` + context (`useTheme` consumes this from `smrt-svelte`) |
| `./themes` | canonical preset token system (material/glass/studio), CSS generation |
| `./styles/tokens.css` | base token stylesheet |

Also internal: `actions/` (`ripple`, `permission`), `display/`, `data/`,
`nav/`, `permissions/`, `utils/`, `test-support/`.

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

## Gotchas

- **i18n split**: the client (here) is dependency-free; the Node-only server
  resolver (`buildI18nSnapshot`, → `@happyvertical/smrt-languages`) stays in
  `@happyvertical/smrt-svelte/i18n/server`. Package string catalogs register via
  `defineMessages` imported from `@happyvertical/smrt-ui/i18n`.
