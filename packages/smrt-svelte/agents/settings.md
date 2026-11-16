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
and labels its empty state. Its optional `onsettled` callback runs once per known
pending/approved/executing hold that canonically succeeds, before publishing the
new views and unmounting its card. Seeded historical successes never notify;
`ondecided` remains the existing human-decision callback. Both props and transport
observations use Chat's shared `reconcileAssistantApprovalView` to retain already
observed canonical progress; normalized rows also return to the card. Final view
publication reconciles again after an awaited host refresh so overlapping holds
cannot regress. No status is inferred from time or a missing row.

While no unsettled card exists, targeted owner-list discovery retries once per
second. It stops when cards take over polling, shares any outstanding list read
across that handoff, and clears timers/discards obsolete results on cleanup.
The existing transport has no abort-signal parameter; unmount cannot cancel an
already-issued network request, but its result cannot publish or notify. Discovery
errors expose no transport details, and host refresh failures do not change the
canonical result. No authority, recovery payload or decision route is added.
The product and generated cookbook Settings share this export. Mounted tests cover
delayed/external completion, callback-driven invalidation, historical/remounted
successes, stale decisions/lists, two-hold overlap, discovery and cleanup, alongside
the existing decision/poll and fail-closed verification cases. Legacy Prebuilt
tests retain their original assertions. MCP architecture/review/introspection and
name/purpose searches found the canonical card and original composition, with no
existing reusable titled owner settings container.

## Assistant

The assistant's settings (workflow handoff, preview before applying, removal
approval, local AI protection) are part of the one inference settings surface,
`InferenceSettingsPanel` in `@happyvertical/smrt-inference/svelte` (#5005).
Which model answers is the tier binding's choice, not a setting here.

