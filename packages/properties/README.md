# @happyvertical/smrt-properties

Digital property and hierarchical zone management for the SMRT framework. Properties represent websites, apps, or publications. Zones form an arbitrarily nested tree within each property for content and ad placement.

## Installation

```bash
pnpm add @happyvertical/smrt-properties
```

## Usage

```typescript
import {
  Property, PropertyCollection,
  Zone, ZoneCollection
} from '@happyvertical/smrt-properties';

// Create a property
const properties = await PropertyCollection.create({ db });
const site = await properties.create({
  name: 'Oak Creek News',
  domain: 'oakcreeknews.com',
  url: 'https://oakcreeknews.com',
  status: 'active',
});
await site.save();

// Build a zone hierarchy: page -> section -> ad slot
const zones = await ZoneCollection.create({ db });
const homePage = await zones.create({
  propertyId: site.id,
  name: 'Home Page',
  type: 'page',
  path: '/',
});
await homePage.save();

const sidebar = await zones.create({
  propertyId: site.id,
  parentId: homePage.id,
  name: 'Sidebar',
  type: 'section',
  selector: '.sidebar',
});
await sidebar.save();

const adSlot = await zones.create({
  propertyId: site.id,
  parentId: sidebar.id,
  name: 'Sidebar Ad',
  type: 'slot',
  width: 300,
  height: 250,
  allowedFormats: ['image', 'html'],
});
await adSlot.save();

// Retrieve the full zone tree for a property
const tree = await zones.getTree(site.id);

// Move a zone (validates against descendant cycles)
await zones.moveZone(adSlot.id, homePage.id);

// Delete a zone — cascade=false moves children to parent
await zones.deleteZone(sidebar.id, false);
```

### Zone hierarchy

Zones use `parentId` self-referencing to form a tree. Common zone types include `page`, `section`, `slot`, `container`, and `widget`. Each zone can specify a URL `path` pattern, CSS `selector`, `position` hint, pixel `width`/`height`, and an `allowedFormats` array for filtering content or ad types. An empty `allowedFormats` array means all formats are allowed (no restrictions).

The `ZoneCollection` provides tree operations: `getTree()` builds a nested structure in memory, `getAncestors()`/`getDescendants()` walk the hierarchy, and `moveZone()` prevents cycles by checking descendants before reparenting. `deleteZone(cascade)` either removes descendants or orphans children to the deleted zone's parent.

## API

### Models

| Export | Description |
|--------|------------|
| `Property` | Digital property (STI) with domain, URL, status, and owner/repository links |
| `Zone` | Hierarchical zone within a property for content/ad placement |

### Collections

| Export | Description |
|--------|------------|
| `PropertyCollection` | CRUD and queries for Property records |
| `ZoneCollection` | Zone CRUD plus tree ops: `getTree()`, `moveZone()`, `deleteZone()`, `getAncestors()`, `getDescendants()` |

### Key Types

`PropertyOptions`, `PropertyStatus`, `ZoneOptions`, `ZoneTree`, `ZoneTreeNode`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- optional multi-tenant scoping
- Peer: `@happyvertical/smrt-profiles`, `@happyvertical/smrt-projects` (optional)
