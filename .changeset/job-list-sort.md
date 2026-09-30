---
'@happyvertical/smrt-jobs': minor
---

`JobList` sorts: every column header is a sortable control (`SortableHeader`
from `@happyvertical/smrt-ui/data`, with `aria-sort`) that toggles its column.
Rows keep the order they are supplied in until a header is activated or the
host passes `sort`. Pass `sort` + `onSortChange` to own the order (e.g. a
server-sorted list).
