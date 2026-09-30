---
'@happyvertical/smrt-jobs': minor
---

`JobList` sorts: newest created first by default, and every column header is a
sortable control (`SortableHeader` from `@happyvertical/smrt-ui/data`, with
`aria-sort`) that toggles its column. Pass `sort` + `onSortChange` to own the
order (e.g. a server-sorted list).
