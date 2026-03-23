# @happyvertical/smrt-products

Product catalog reference template demonstrating triple-consumption: npm package library, module federation, and standalone REST API server.

## Installation

```bash
pnpm add @happyvertical/smrt-products
```

## Usage

### Import as npm library

```typescript
import { Product, ProductCollection, Category } from '@happyvertical/smrt-products';
import { startServer } from '@happyvertical/smrt-products';
import { generateMCPServer } from '@happyvertical/smrt-products';
import { AssetCollection } from '@happyvertical/smrt-assets';

// Start standalone REST API server
const { shutdown } = await startServer();

const products = await ProductCollection.create();
const assets = await AssetCollection.create();
const product = await products.create({
  name: 'Demo Product',
  price: 29.99,
});
const hero = await assets.create({
  name: 'demo-product-hero.jpg',
  sourceUri: 'file:///tmp/demo-product-hero.jpg',
  mimeType: 'image/jpeg',
});

await product.addAsset(hero, 'hero');
await products.addAsset(product.id!, hero, 'gallery', 1);
```

### Three consumption modes

1. **NPM library** -- import classes, components, and stores directly
2. **Module federation** -- runtime component sharing (experimental)
3. **Standalone API** -- `startServer()` launches Express with auto-generated routes

## API

### Top-Level Exports

| Export | Description |
|--------|------------|
| `startServer` | Launch standalone REST API server |
| `generateMCPServer` | Generate MCP server for AI tool integration |
| `demonstrateClient` | Demo of auto-generated TypeScript client |
| `startAll` | Start all services (REST + MCP) |

### Models (from `lib/models`)

| Export | Description |
|--------|------------|
| `Product` | STI-enabled product with specs and tags |
| `Category` | Hierarchical category (parentId, level, productCount), STI enabled |
| `ProductAsset` | Dedicated owned-asset join stored in `product_assets` with `relationship` and `sortOrder`; intentionally not tenant-scoped because `Product` is not tenant-scoped |

### Collections (from `lib/collections`)

| Export | Description |
|--------|------------|
| `ProductCollection` | CRUD plus `findByManufacturer()`, `findInStock()`, and owned asset wrappers |
| `ProductAssetCollection` | Direct access to `product_assets` rows plus asset helper wrappers |

### Components (from `lib/components`)

| Export | Description |
|--------|------------|
| `ProductCard` | Svelte 5 product display component |
| `ProductForm` | Svelte 5 product edit form |

### Stores (from `lib/stores`)

| Export | Description |
|--------|------------|
| `ProductStoreClass` | Svelte 5 rune-based state management class |
| `productStore` | Singleton store instance |

### Utilities (from `lib/utils`)

| Export | Description |
|--------|------------|
| `formatPrice` | Format number as USD currency string |
| `formatDate` | Format date as human-readable string |
| `slugify` | Convert text to URL-friendly slug |
| `generateId` | Generate random ID string |

### Virtual Modules (Vite plugin)

| Export | Description |
|--------|------------|
| `createClient` | Auto-generated TypeScript API client |
| `setupRoutes` | Auto-generated Express routes |
| `createMCPServer` | Auto-generated MCP server |
| `manifest` | SMRT object metadata |

Owned asset helpers are available on both `Product` and `ProductCollection` via
`getAssets()`, `addAsset()`, and `removeAsset()`. Common relationships include
`hero`, `gallery`, `attachment`, and `thumbnail`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | SmrtObject/SmrtCollection base classes, REST server, MCP generator |
| `@happyvertical/smrt-assets` | Shared Asset / AssetCollection types used by product-owned asset helpers |
| `@happyvertical/sql` | Database operations |
| `@happyvertical/ai` | AI integration |
