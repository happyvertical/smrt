# @happyvertical/smrt-properties

Digital properties (websites, apps) with hierarchical zones for content/ad placement.

## Models

- **Property** (STI): `domain`, `url`, optional repository/owner links. Status: active/inactive/pending. Methods dynamically import/create ZoneCollection for lazy loading.
- **Zone**: hierarchical via `parentId`. `path`/`selector`/`dimensions` for placement. `allowedFormats` array. Tree operations: `getAncestors()`, `getDescendants()`, `getFullPath()`, `moveZone()` (with cycle detection).

## ZoneCollection Key Methods

`getTree()` (builds nested structure), `moveZone()` (validates against descendant cycles), `deleteZone(cascade?)` (cascade=false orphans children to parent), `findWithGlobals(tenantId)`.

In-memory depth caching prevents N+1 queries during tree operations.

## Gotchas

- **Empty allowedFormats = all formats**: empty array means no restrictions, not no formats
- **Zone dimensions nullable independently**: check `hasDimensions()` before using width/height
- **deleteZone(cascade=false)**: doesn't delete children — moves them to parent (orphan pattern)
- **Optional tenancy** on both models
