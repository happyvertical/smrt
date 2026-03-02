# @happyvertical/smrt-properties

Digital property and hierarchical zone management for the SMRT framework. Properties represent digital assets (websites, apps) with nested zones for content and ad placement.

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
const properties = new PropertyCollection(db);
const site = await properties.create({
  name: 'Main Website',
  domain: 'example.com',
  status: 'active',
});
await site.save();

// Create hierarchical zones
const zones = new ZoneCollection(db);
const header = await zones.create({
  propertyId: site.id,
  name: 'Header',
  slug: 'header',
});
await header.save();

const headerAd = await zones.create({
  propertyId: site.id,
  name: 'Header Ad Slot',
  slug: 'header-ad',
  parentId: header.id,
});
await headerAd.save();
```

## API

### Models

| Export | Description |
|--------|------------|
| `Property` | Digital property with domain, status, and metadata |
| `Zone` | Hierarchical zone within a property for content/ad placement |

### Collections

`PropertyCollection`, `ZoneCollection`

### Key Types

`PropertyOptions`, `PropertyStatus`, `ZoneOptions`, `ZoneTree`, `ZoneTreeNode`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- Peer: `@happyvertical/smrt-profiles`, `@happyvertical/smrt-projects`
