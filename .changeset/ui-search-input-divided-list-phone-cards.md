---
'@happyvertical/smrt-ui': minor
---

New list pieces apps were hand-building:

- `SearchInput` (`@happyvertical/smrt-ui/forms`): the search box of a list's filter bar. It searches as you type (debounced) and on Enter, reports the trimmed single-line text, follows the applied search it is given back, clears with an x, and is a 44px, 16px-on-phones field.
- `CollectionList` `layout="divided"`: a flat single column, rows separated by a hairline, a selected row shown by its checkbox. The selection checkbox is now a 44px target in every layout.
- `DataTable` `phoneLayout="cards"`: on phones each row becomes a block of stacked cells and the column heads hide (pair it with a `ListSortSelect`).
