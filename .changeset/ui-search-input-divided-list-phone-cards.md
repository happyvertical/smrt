---
'@happyvertical/smrt-ui': minor
---

New list pieces apps were hand-building:

- `SearchInput` (`@happyvertical/smrt-ui/forms`): the search box of a list's filter bar. It searches as you type (debounced) and on Enter, reports the trimmed single-line text, follows the applied search it is given back, clears with an x, and is a 44px, 16px-on-phones field.
- `CollectionList` `layout="divided"`: a flat single column, rows separated by a hairline, a selected row shown by its checkbox. The selection checkbox is now a 44px target in every layout.
- `DataTable` `phoneLayout="cards"`: on phones each row becomes a block of stacked cells, each cell headed by its column's name, and the column-head row is hidden visually (pair it with a `ListSortSelect`). The table keeps explicit `table`/`row`/`columnheader`/`cell` roles in this mode, so screen readers still announce the structure and each cell's column; a virtualized table keeps its own scroller.
- `Fieldset` `stack`: lay the fields out in one column with a gap.
- `SortableHeader` reads `--sortable-header-font-weight` (default 600; `inherit` takes the head row's weight), next to `--sortable-header-padding`.
