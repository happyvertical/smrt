# @happyvertical/smrt-properties

Digital properties (websites, apps) with hierarchical zones for content/ad placement.

## Models

- **Property** (STI): `domain`, `url`, optional repository/owner links. Status: active/inactive/pending. Methods dynamically import/create ZoneCollection for lazy loading.
- **Zone**: hierarchical via `parentId`. `path`/`selector`/`dimensions` for placement. `allowedFormats` array. Tree operations: `getAncestors()`, `getDescendants()`, `getFullPath()`, `moveZone()` (with cycle detection).

## ZoneCollection Key Methods

`getTree()` (builds nested structure), `moveZone()` (validates against descendant cycles), `deleteZone(cascade?)` (cascade=false orphans children to parent), `findWithGlobals(tenantId)`.

In-memory depth caching prevents N+1 queries during tree operations.

## Property Key Methods

- `getZones()` / `getZoneTree()` / `createZone()` — ZoneCollection wrappers loaded lazily via dynamic import.
- `isActive()` — convenience status check.
- AI: `summarize()` (uses `smrtProperties.property.summarize` prompt via `@happyvertical/smrt-prompts`).

## Prompt Registry

`Property.summarize()` is registered with `@happyvertical/smrt-prompts` so tenants can override the template/model/params at runtime:

```typescript
import { smrtPropertiesSummarizePrompt } from '@happyvertical/smrt-properties';
// key: 'smrtProperties.property.summarize'
```

Only non-PII fields are passed to the AI provider: `name`, `domain`, `description`, `status`, plus aggregate zone information (count + top-level zone names). Internal foreign-key fields (`ownerId`, `repositoryId`, `tenantId`) and the extensible `metadata` blob are intentionally excluded — `metadata` may contain analytics IDs or tenant-private configuration.

## Gotchas

- **Empty allowedFormats = all formats**: empty array means no restrictions, not no formats
- **Zone dimensions nullable independently**: check `hasDimensions()` before using width/height
- **deleteZone(cascade=false)**: doesn't delete children — moves them to parent (orphan pattern)
- **Optional tenancy** on both models
