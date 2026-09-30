---
'@happyvertical/smrt-ui': minor
'@happyvertical/smrt-svelte': minor
---

One sorting contract for lists. `@happyvertical/smrt-ui/data` adds `list-sort`
helpers (`parseListSort`, `toggleListSort`, `listSortSearchParams`/`listSortHref`
for `?sort=&dir=` URL state, `listSortAria`, `sortListRows`, and an allow-listed
`listSortOrderBy` for server queries), a `SortableHeader` for hand-rolled tables
(link or button, `aria-sort`, arrow indicator), and a `ListSortSelect` "Sort by"
picker for card lists. `DataTable` columns take `sortFirstDirection` (e.g. dates
start newest first) and the table takes `sortClearable={false}` to toggle asc ⇄ desc
without clearing. `useListSurface` publishes the list's `sort`, declares `sortable`
columns, and accepts a `set-sorting` command through the page's own `onSort`.
