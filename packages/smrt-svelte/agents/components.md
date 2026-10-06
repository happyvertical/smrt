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
| Forms (`/forms`) | `TextInput`, `Select`, `MoneyInput`, `DateTimeInput`, `Toggle`, `FileUpload`, `AddressInput`, `RelationInput`, + more (AI-wired inputs use the hooks/browser-ai here) |
| Module | `ModulePanel` |
| Settings (`/settings`) | `SettingsCatalog`, `paginateSettingsCatalog` |
| Audit (root export) | `RecordHistory`, `AuditList` — authorized data props; [contract](../../../docs/content/audit-trail.md) |
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
  drop zones. With `name` it posts in a native `multipart/form-data` submit:
  the accepted list (picks, drops, removals, bound resets) is mirrored onto the
  visually-hidden input via `DataTransfer` — never `hidden`, which would break
  `required` validation. Without that constructor the input keeps only a
  native selection that matches the list, else clears (#3260). A reset of the
  owning form (`form.reset()`, a reset button, `enhance`'s `update()`) empties
  the list and reports `onchange([])`, so the list never shows files that no
  longer post.
- **`Modal` + forms** (`./feedback` + `./forms`) — compose for dialogs; no
  bespoke modal shells.
- **`ConfirmDialog`** (`./feedback`) — the standard confirm/destructive-action
  flow.
- **`Card`** (`./ui`) — the standard surface/container; retire local card CSS.

### `RelationInput` (`./forms`, #3600)

Searchable single-select for relation (foreign-key) fields, a thin wrapper over
the smrt-ui `Combobox`. It is presentation only: the caller supplies the data,
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
- **Form integration** is through `Combobox`'s control registration (rich `Form`
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

### Import convention (S10 #1415)

Domain packages **consume** these primitives; they do not re-roll them. The
duplication of Modal/Form/Button/Avatar across packages is the root cause of
inconsistent a11y, tokens, and states downstream — fix it by importing from the
library. Which barrel for what:

| Need | Import from |
|------|-------------|
| Buttons, cards, badges, avatars, chips, skeletons, tooltips, dropdowns, trees, pagination | `@happyvertical/smrt-ui/ui` |
| Provider-free base inputs — `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` | `@happyvertical/smrt-ui/forms` (also re-exported from `@happyvertical/smrt-svelte/forms`) |
| Provider-free `Form` (plain `<form>` wrapper) | `@happyvertical/smrt-ui/forms` **only** — `@happyvertical/smrt-svelte/forms` exports the *rich* Provider-backed `Form` under that name, so import the plain one straight from smrt-ui |
| Provider-backed inputs — `TextInput`, `NumberInput`, `MoneyInput`, date/measurement/address inputs, `CheckboxInput`, file upload, the rich `Form` | `@happyvertical/smrt-svelte/forms` |
| `Modal`, `ConfirmDialog`, `LoadingOverlay`, `ProgressBar` | `@happyvertical/smrt-ui/feedback` |
| `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState` | `@happyvertical/smrt-ui/layout` |
| Chat message bubble, reaction picker, typing indicator | `@happyvertical/smrt-ui/chat` |
| Admin shell, tenant navigation, focus tools, settings, and activities | `@happyvertical/smrt-svelte/workspace` |
| First-generation ToolsDock during AdminShell migration | `@happyvertical/smrt-svelte/workspace/legacy` |
| Server-paged settings search, selection, and list/detail layout | `@happyvertical/smrt-svelte/settings` |

The domain-agnostic primitives are **not** re-exported by smrt-svelte: its
`exports` map has no `./ui`, `./feedback`, `./layout`, `./chat`, or `./registry`,
so those specifiers fail to resolve — import them from `@happyvertical/smrt-ui`.
The smrt-svelte root does re-export `./forms`, but prefer the specific subpath
in domain code for tree-shaking and clarity.

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
