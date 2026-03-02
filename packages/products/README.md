# @happyvertical/smrt-products

Product catalog reference template demonstrating triple-consumption: npm package library, module federation, and standalone REST API server.

## Installation

```bash
pnpm add @happyvertical/smrt-products
```

## Usage

### Import as npm library

```typescript
import { Product, Category } from '@happyvertical/smrt-products';
import { startServer } from '@happyvertical/smrt-products';
import { generateMCPServer } from '@happyvertical/smrt-products';

// Start standalone REST API server
const { shutdown } = await startServer();

// Or use models directly
const product = new Product();
product.name = 'Demo Product';
product.price = 29.99;
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

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | SmrtObject/SmrtCollection base classes, REST server, MCP generator |
| `@happyvertical/sql` | Database operations |
| `@happyvertical/ai` | AI integration |
