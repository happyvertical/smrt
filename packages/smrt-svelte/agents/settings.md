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
