# @happyvertical/smrt-properties

Digital property and hierarchical zone management for content placement, ad slots, and multi-tenant resource allocation.

## Architecture

```
src/
  index.ts              # Export barrel
  types.ts              # PropertyStatus, ZoneTree, ZoneTreeNode
  models/
    Property.ts         # Digital property (website, app, publication)
    Zone.ts             # Hierarchical area within a property
  collections/
    Properties.ts       # PropertyCollection
    Zones.ts            # ZoneCollection with hierarchy queries
```

## Key Models

- `Property` — Digital property: domain, URL, status, owner/repository links, tier
- `Zone` — Hierarchical placement area: page, section, slot, widget with parentId, path, dimensions

## Key Patterns

- **Zone hierarchy**: Parent-child via `parentId` with tree traversal methods
- **Zone types**: page, section, slot, widget — organizing content placement areas
- **Path-based lookup**: `findByPath()` for URL-based zone resolution
- **Tree operations**: `getTree()` returns full hierarchical structure
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- Optional peer: `@happyvertical/smrt-profiles` (owner), `@happyvertical/smrt-projects` (repository)
