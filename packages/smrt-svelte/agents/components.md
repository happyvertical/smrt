# smrt-svelte/components

Module semantics for `src/components/`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Components

The domain-agnostic primitives (`ui`, `layout`, `feedback`, `nav`, `display`,
`calendar`, `chat`, `permissions`, **`roles`/`memberships`**, `theme`) and the
i18n client / module registry moved to `@happyvertical/smrt-ui` — import them
from there (`@happyvertical/smrt-ui/{ui,layout,feedback,…}`). This package keeps
the top-of-stack, domain-aware pieces:

| Category | Components |
|----------|------------|
| AI | `Provider`, `AILoadingOverlay`, `CapabilityGate`, `DownloadProgress`, `STTTest`, `VoiceInput` |
| Forms (`/forms`) | `TextInput`, `Select`, `MoneyInput`, `DateTimeInput`, `Toggle`, `FileUpload`, `AddressInput`, + more (AI-wired inputs use the hooks/browser-ai here) |
| Module | `ModulePanel` |
| Settings (`/settings`) | `SettingsCatalog`, `paginateSettingsCatalog` |
| Workspace (`/workspace`) | `AdminShell`, `ShellState`, `TenantNav`, focus tools, settings, activities, and system/app panels |
| Legacy workspace (`/workspace/legacy`) | First-generation `ToolsDock` compatibility surface during AdminShell migration |

### Gap primitives & S10 consolidation (L3 #1422)

L3 added the generic primitives domain packages were re-rolling, so S10 (#1415)
has a consolidation target: `Avatar`, `Chip`, `Skeleton`, `Tooltip`, `Dropdown`
(menu-button), and `Tree` (flat-DOM ARIA tree, generalizes `NavTree`) under
`./ui`; plus `MessageBubble`, `ReactionPicker`, `TypingIndicator` under the
`./chat` subpath. Each ships with design tokens, keyboard + ARIA a11y, JSDoc'd
props, a golden test, and a playground page (`playground/.../primitives`).

**Adoption-only for S10** — these already meet the library bar; S10 should
migrate domain re-rolls *onto* them rather than build new primitives:

- **`FileUpload`** (`./forms`) — the canonical upload input; replace ad-hoc
  drop zones.
- **`Modal` + forms** (`./feedback` + `./forms`) — compose for dialogs; no
  bespoke modal shells.
- **`ConfirmDialog`** (`./feedback`) — the standard confirm/destructive-action
  flow.
- **`Card`** (`./ui`) — the standard surface/container; retire local card CSS.

### Import convention (S10 #1415)

Domain packages **consume** these primitives; they do not re-roll them. The
duplication of Modal/Form/Button/Avatar across packages is the root cause of
inconsistent a11y, tokens, and states downstream — fix it by importing from the
library. Which barrel for what:

| Need | Import from |
|------|-------------|
| Buttons, cards, badges, avatars, chips, skeletons, tooltips, dropdowns, trees, pagination | `@happyvertical/smrt-svelte/ui` (or the package root) |
| Provider-free base inputs — `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` | `@happyvertical/smrt-ui/forms` (also re-exported from `@happyvertical/smrt-svelte/forms`) |
| Provider-free `Form` (plain `<form>` wrapper) | `@happyvertical/smrt-ui/forms` **only** — `@happyvertical/smrt-svelte/forms` exports the *rich* Provider-backed `Form` under that name, so import the plain one straight from smrt-ui |
| Provider-backed inputs — `TextInput`, `NumberInput`, `MoneyInput`, date/measurement/address inputs, `CheckboxInput`, file upload, the rich `Form` | `@happyvertical/smrt-svelte/forms` |
| `Modal`, `ConfirmDialog`, `LoadingOverlay`, `ProgressBar` | `@happyvertical/smrt-svelte/feedback` |
| `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState` | `@happyvertical/smrt-svelte/layout` |
| Chat message bubble, reaction picker, typing indicator | `@happyvertical/smrt-svelte/chat` |
| Admin shell, tenant navigation, focus tools, settings, and activities | `@happyvertical/smrt-svelte/workspace` |
| First-generation ToolsDock during AdminShell migration | `@happyvertical/smrt-svelte/workspace/legacy` |
| Server-paged settings search, selection, and list/detail layout | `@happyvertical/smrt-svelte/settings` |

The package root re-exports `./ui`, `./forms`, etc., so `from
'@happyvertical/smrt-svelte'` also works; prefer the specific subpath in domain
code for tree-shaking and clarity.

**Consolidating an existing re-roll** — two patterns:

1. **Direct use** (preferred for new code and when the local API already matches):
   delete the local component, import the library primitive at each call site.
2. **Thin adapter** (when a package has an established, differing prop vocabulary
   or a `ModuleUIRegistry` registration to preserve): keep the local file but
   reduce it to a wrapper that maps the package's props onto the library
   component — no duplicated markup/styles/logic. Example:
   `chat/.../shared/Avatar.svelte` maps `avatarUrl`→`src` and `onlineStatus`'s
   `dnd`→the library's `busy`, delegating everything else.

**Missing a primitive or prop?** Add it upstream in `smrt-svelte`, don't re-roll
downstream (e.g. the library `Avatar` gained an image-error→initials fallback
while consolidating chat's avatar).

### Gap primitives & S10 consolidation (L3 #1422)

L3 added the generic primitives domain packages were re-rolling, so S10 (#1415)
has a consolidation target: `Avatar`, `Chip`, `Skeleton`, `Tooltip`, `Dropdown`
(menu-button), and `Tree` (flat-DOM ARIA tree, generalizes `NavTree`) under
`./ui`; plus `MessageBubble`, `ReactionPicker`, `TypingIndicator` under the
`./chat` subpath. Each ships with design tokens, keyboard + ARIA a11y, JSDoc'd
props, a golden test, and a playground page (`playground/.../primitives`).

**Adoption-only for S10** — these already meet the library bar; S10 should
migrate domain re-rolls *onto* them rather than build new primitives:

- **`FileUpload`** (`./forms`) — the canonical upload input; replace ad-hoc
  drop zones.
- **`Modal` + forms** (`./feedback` + `./forms`) — compose for dialogs; no
  bespoke modal shells.
- **`ConfirmDialog`** (`./feedback`) — the standard confirm/destructive-action
  flow.
- **`Card`** (`./ui`) — the standard surface/container; retire local card CSS.

### Import convention (S10 #1415)

Domain packages **consume** these primitives; they do not re-roll them. The
duplication of Modal/Form/Button/Avatar across packages is the root cause of
inconsistent a11y, tokens, and states downstream — fix it by importing from the
library. Which barrel for what:

| Need | Import from |
|------|-------------|
| Buttons, cards, badges, avatars, chips, skeletons, tooltips, dropdowns, trees, pagination | `@happyvertical/smrt-svelte/ui` (or the package root) |
| Provider-free base inputs — `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` | `@happyvertical/smrt-ui/forms` (also re-exported from `@happyvertical/smrt-svelte/forms`) |
| Provider-free `Form` (plain `<form>` wrapper) | `@happyvertical/smrt-ui/forms` **only** — `@happyvertical/smrt-svelte/forms` exports the *rich* Provider-backed `Form` under that name, so import the plain one straight from smrt-ui |
| Provider-backed inputs — `TextInput`, `NumberInput`, `MoneyInput`, date/measurement/address inputs, `CheckboxInput`, file upload, the rich `Form` | `@happyvertical/smrt-svelte/forms` |
| `Modal`, `ConfirmDialog`, `LoadingOverlay`, `ProgressBar` | `@happyvertical/smrt-svelte/feedback` |
| `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState` | `@happyvertical/smrt-svelte/layout` |
| Chat message bubble, reaction picker, typing indicator | `@happyvertical/smrt-svelte/chat` |
| Admin shell, tenant navigation, focus tools, settings, and activities | `@happyvertical/smrt-svelte/workspace` |
| First-generation ToolsDock during AdminShell migration | `@happyvertical/smrt-svelte/workspace/legacy` |
| Server-paged settings search, selection, and list/detail layout | `@happyvertical/smrt-svelte/settings` |

The package root re-exports `./ui`, `./forms`, etc., so `from
'@happyvertical/smrt-svelte'` also works; prefer the specific subpath in domain
code for tree-shaking and clarity.

**Consolidating an existing re-roll** — two patterns:

1. **Direct use** (preferred for new code and when the local API already matches):
   delete the local component, import the library primitive at each call site.
2. **Thin adapter** (when a package has an established, differing prop vocabulary
   or a `ModuleUIRegistry` registration to preserve): keep the local file but
   reduce it to a wrapper that maps the package's props onto the library
   component — no duplicated markup/styles/logic. Example:
   `chat/.../shared/Avatar.svelte` maps `avatarUrl`→`src` and `onlineStatus`'s
   `dnd`→the library's `busy`, delegating everything else.

**Missing a primitive or prop?** Add it upstream in `smrt-svelte`, don't re-roll
downstream (e.g. the library `Avatar` gained an image-error→initials fallback
while consolidating chat's avatar).
