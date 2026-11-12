# smrt-svelte/settings catalog

Module semantics for `src/components/settings/` (`./settings`). Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Scalable settings catalog (`./settings`)

`SettingsCatalog` is the shared search/browse/select/edit shell for large
code-first or database-backed settings registries. Its interface accepts a
server-produced `SettingsCatalogPage`: callers keep transport, authorization,
and domain-specific editor forms, while the module owns compact result rows,
GET search, query-preserving selection links, bounded pagination, result counts,
empty states, and responsive list/detail layout.

`paginateSettingsCatalog()` is the optional server helper for definitions that
already live in memory (prompt and language registries). It searches before
paging, clamps pages, caps rendered slices at 100 rows, and selects only one
detail item. Database-backed callers should query their own page and construct
the same `SettingsCatalogPage` interface directly rather than loading every row.

The summary-row type and selected-detail type may differ: list pages can remain
cheap while only the selected definition is fully resolved. This is the
scalability contract; do not resolve every settings editor before passing data
to the catalog.

## Pre-built components

`PrebuiltComponentsSettings` composes the existing preference control and restart
link. Supply the current `enabled` value and an authorized `onsave` callback;
failed saves restore the last persisted choice and show a fixed translated error.
The checkbox has a visible On/Off status and a plain explanation. New hosts mount
`OwnerApprovalsSettings` separately near the top of Settings. Legacy optional
`approvals`, `transport` and `ondecided` props remain supported by delegating to
that same component. The preference control owns no store or approval authority.

`OwnerApprovalsSettings` extracts the existing status filter and transport
observation composition once. It renders the canonical chat `AssistantApprovalCard`
for pending/approved/executing records from an authorized host loader, removes
terminal outcomes observed through the card's existing decision or polling calls,
and labels its empty state. It adds no poller, authority, recovery payload or
decision route. The product and generated cookbook Settings share this export.
Owning mounted tests retain decision/poll removal and fail-closed verification;
legacy Prebuilt tests remain unchanged. MCP architecture/review/introspection and
name/purpose searches found the canonical card and original composition, with no
existing reusable titled owner settings container.

## Assistant quality

`WorkProfileSettings` composes smrt-ui Card, FormGroup, Input, Select, Toggle and
Button. The host supplies sparse overrides, resolved profiles, an editable flag,
and authorized save/reset callbacks. Each profile exposes engine, model, effort,
all inference budgets and preview; assist additionally exposes automatic design
escalation. It owns no model policy, persistence or approval authority. Unknown
engine/catalog resolution is shown as unavailable while editing/reset remain
usable. CLI token limits are explicitly advisory where the CLI cannot enforce a
per-call ceiling; app-tool count and wall-time checks remain host-enforced.
The note describes own-plan/API-key billing. Safety switches are absent.

MCP architecture inventory and intent/name/purpose searches found inference's
resolver, preferences' kind store, SettingsCatalog and ConnectAi. The editor adds
only the missing domain composition, reusing the shared visual/form primitives
and translated messages. Mounted tests exercise edit/save/reset, refused save,
unavailable connection repair and accessibility.

Save forwards sparse owner overrides, not the resolved defaults shown in the
controls. Untouched Save and unrelated effort/preview/budget edits must not
materialize `budgets.passes`; the design host can size a default run within its
recommended maximum. An explicitly saved pass count, including the recommended
number itself, remains an owner override. Reset removes the preference and the
next loader supplies `{}`. Mounted regressions cover untouched/unrelated edits,
explicit two/four-pass round trips and reset followed by sparse Save.
