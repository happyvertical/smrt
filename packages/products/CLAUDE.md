# @have/products: Triple-Purpose SMRT Microservice Template

## Purpose and Responsibilities

The `@have/products` package is a comprehensive reference implementation demonstrating the SMRT framework's code generation capabilities. It serves as both a working example and a template for building production-ready microservices that leverage auto-generation from `@smrt()` decorated classes.

### Three Consumption Patterns

This package demonstrates how to create a single codebase that can be consumed in three different ways:

1. **NPM Package Library**: Traditional build-time imports for maximum tree-shaking and optimization
2. **Module Federation Provider**: Runtime component sharing across applications (experimental)
3. **Standalone Application**: Complete, independent REST API server with full CRUD functionality

### What Gets Auto-Generated

The `@smrt()` decorator on model classes automatically generates:
- **REST APIs**: Full CRUD endpoints (list, get, create, update, delete) via `@have/smrt`'s `startRestServer()`
- **TypeScript Client**: Type-safe API client with IntelliSense support (via `@smrt/client` virtual module)
- **MCP Tools**: Model Context Protocol tools for AI agent integration (via `@smrt/mcp` virtual module)
- **Type Definitions**: Complete TypeScript types for all models and API responses (via `@smrt/types` virtual module)
- **Route Setup**: Express route handlers (via `@smrt/routes` virtual module)
- **Manifest**: Metadata about models and their configurations (via `@smrt/manifest` virtual module)

### Current Status

**Production Ready**:
- SMRT model definitions (Product, Category) with full `@smrt()` decorator configuration
- REST API server with auto-generated routes via `startRestServer()`
- TypeScript client generation via Vite plugins
- MCP tool generation for AI integration
- Svelte 5 state management with runes (`$state`, `$derived`, `$effect`)

**Experimental/In Development**:
- Module federation (basic configuration in place, not fully tested)
- UI component library (minimal components available: ProductCard, ProductForm, TestComponent)
- Standalone application mode (API server works, full app in progress)

**Expert Agent Expertise**: When working with this package, always proactively check the latest documentation for module federation (@originjs/vite-plugin-federation), Svelte 5 runes, and SMRT framework updates, as they frequently add new features and capabilities that can enhance microservice architecture.

### Key Implementation Details

**Virtual Modules System**: The package relies heavily on Vite plugins (`smrtPlugin` and `smrtConsumer`) that generate "virtual modules" - modules that don't exist as physical files but are resolved at build/runtime. These include:
- `@smrt/client` - Auto-generated TypeScript API client
- `@smrt/types` - Auto-generated TypeScript type definitions
- `@smrt/routes` - Auto-generated Express route handlers
- `@smrt/mcp` - Auto-generated MCP tool definitions
- `@smrt/manifest` - Metadata manifest with decorator configs

**Mock Client**: Currently uses `src/lib/mock-smrt-client.ts` for development and testing since the virtual module generation is still in progress. This provides a working implementation that demonstrates the intended API structure.

## Package Structure

```
packages/products/
├── src/
│   ├── lib/                          # Library code (NPM package exports)
│   │   ├── models/                   # SMRT model definitions
│   │   │   ├── Product.ts           # Product model with @smrt() decorator
│   │   │   ├── Category.ts          # Category model with @smrt() decorator
│   │   │   └── index.ts             # Model exports
│   │   ├── components/              # Svelte 5 UI components
│   │   │   ├── ProductCard.svelte   # Product display card (Svelte 5 $props rune)
│   │   │   ├── ProductForm.svelte   # Product edit form
│   │   │   ├── TestComponent.svelte # Minimal test component
│   │   │   └── index.ts             # Component exports
│   │   ├── stores/                  # Svelte 5 runes state management
│   │   │   ├── product-store.svelte.ts        # Server-side store with $state
│   │   │   ├── product-store.client.svelte.ts # Client-side store (separate)
│   │   │   └── index.ts             # Store exports
│   │   ├── types/                   # TypeScript type definitions
│   │   │   ├── smrt-generated/      # Auto-generated types from prebuild script
│   │   │   └── index.ts             # Type exports
│   │   ├── generated/               # Auto-generated code (reserved for future use)
│   │   │   └── index.ts
│   │   ├── utils/                   # Utility functions
│   │   │   └── index.ts
│   │   ├── mock-smrt-client.ts      # Mock client (temporary, replaces @smrt/client)
│   │   ├── types.ts                 # Core type definitions (ProductData, etc.)
│   │   ├── federation-entry.ts      # Module federation entry point
│   │   └── index.ts                 # Main library export (re-exports all modules)
│   ├── federation/                  # Module federation configuration
│   │   ├── expose.config.ts         # What this service exposes to federation
│   │   ├── consume.config.ts        # What this service consumes from other services
│   │   └── shared.config.ts         # Shared dependencies between services
│   ├── app/                         # Standalone application entry
│   │   └── main.ts                  # Standalone app entry point
│   ├── server.ts                    # REST API server using startRestServer()
│   ├── client.ts                    # Client demonstration and testing
│   ├── mcp.ts                       # MCP server for AI integration
│   ├── main.ts                      # Legacy main entry point
│   └── index.ts                     # Package entry point (exports all public APIs)
├── scripts/
│   └── generate-smrt-types.js       # Prebuild script: generates type declarations
├── vite.config.ts                   # Multi-mode Vite configuration (library/federation/standalone)
├── federation.config.ts             # Federation setup (consolidates federation configs)
├── package.json                     # Package metadata, scripts, dependencies
└── CLAUDE.md                        # This file - package documentation
```

**Key Files to Understand**:

1. **`src/lib/models/Product.ts`** - Example SMRT model with `@smrt()` decorator showing all configuration options
2. **`src/server.ts`** - Shows how to start REST API server with `startRestServer([Product, Category])`
3. **`src/mcp.ts`** - Shows how to create MCP server with auto-generated tools from virtual modules
4. **`src/lib/stores/product-store.svelte.ts`** - Complete Svelte 5 store example with $state rune
5. **`vite.config.ts`** - Multi-mode configuration showing how to build for different targets
6. **`scripts/generate-smrt-types.js`** - Prebuild script that generates TypeScript declarations
7. **`src/lib/mock-smrt-client.ts`** - Mock client implementation showing expected API structure

## Key APIs and Usage

### 1. NPM Package Library Usage (Primary Pattern)

The most common and production-ready usage pattern:

```typescript
// Import models
import { Product, Category } from '@have/products';
import type { ProductData, CategoryData } from '@have/products';

// Import auto-generated client
import { createClient } from '@have/products';

// Import stores (Svelte 5 runes)
import { productStore } from '@have/products/stores';

// Create model instances
const product = new Product({
  name: 'Example Product',
  description: 'A great product',
  price: 29.99,
  inStock: true,
  category: 'electronics',
  tags: ['demo', 'example']
});

// Use auto-generated TypeScript client
const client = createClient('/api/v1');
const response = await client.products.list();
const products = response.data; // Fully typed as ProductData[]

// Create new product via API
await client.products.create({
  name: 'New Product',
  price: 49.99
});

// Update existing product
await client.products.update('product-id', {
  price: 39.99
});
```

### 2. REST API Server Usage

Start the auto-generated REST API server:

```typescript
import { startServer } from '@have/products';

// Starts Express server with auto-generated routes
const { shutdown } = await startServer();

// Server runs on http://localhost:3000/api/v1
// GET    /api/v1/products        - List all products
// POST   /api/v1/products        - Create product
// GET    /api/v1/products/:id    - Get single product
// PUT    /api/v1/products/:id    - Update product
// GET    /api/v1/categories      - List all categories
// POST   /api/v1/categories      - Create category
// GET    /api/v1/categories/:id  - Get single category
// PUT    /api/v1/categories/:id  - Update category
```

### 3. MCP Server for AI Integration

Enable AI agents to interact with your models:

```typescript
import { startMCPServer } from '@have/products';

// Starts Model Context Protocol server
const mcp = await startMCPServer();

// Auto-generated MCP tools:
// - list_products: List all products
// - get_product: Get single product by ID
// - list_categories: List all categories
// - get_category: Get single category by ID
```

### 4. Svelte 5 Store Usage (Client-Side)

Use the reactive store for state management:

```svelte
<script>
  import { productStore } from '@have/products/stores';

  // Load products on mount
  $effect(() => {
    productStore.loadProducts();
  });

  // Reactive getters
  const items = $derived(productStore.items);
  const loading = $derived(productStore.loading);
  const inStockCount = $derived(productStore.inStockCount);
  const totalValue = $derived(productStore.totalValue);

  async function handleCreate() {
    await productStore.createProduct({
      name: 'New Product',
      price: 29.99,
      inStock: true
    });
  }

  async function handleUpdate(id: string) {
    await productStore.updateProduct(id, {
      price: 39.99
    });
  }

  function handleSearch(query: string) {
    return productStore.searchProducts(query);
  }
</script>

{#if loading}
  <p>Loading...</p>
{:else}
  <p>Found {items.length} products ({inStockCount} in stock)</p>
  <p>Total value: ${totalValue.toFixed(2)}</p>
{/if}
```

## SMRT Model Definitions

### Product Model (src/lib/models/Product.ts)

The Product model demonstrates all SMRT decorator capabilities:

```typescript
import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';

export interface ProductOptions extends SmrtObjectOptions {
  name?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
  model?: string;
  price?: number;
  inStock?: boolean;
  specifications?: Record<string, any>;
  tags?: string[];
}

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'], // Exclude 'delete'
  },
  mcp: {
    include: ['list', 'get'], // Only expose read operations to AI
  },
  cli: true, // Enable CLI commands for admin
})
export class Product extends SmrtObject {
  name = '';
  description = '';
  category = ''; // Reference to category
  manufacturer = '';
  model = '';
  price = 0;
  inStock = true;
  specifications: Record<string, any> = {};
  tags: string[] = [];

  constructor(options: ProductOptions = {}) {
    super(options);
    Object.assign(this, options);
  }

  // Instance methods (not auto-generated, custom business logic)
  async getSpecification(key: string): Promise<any> {
    return this.specifications[key];
  }

  async updateSpecification(key: string, value: any): Promise<void> {
    this.specifications[key] = value;
  }

  // Static methods (queries, will be auto-implemented by SMRT)
  static async searchByText(_query: string): Promise<Product[]> {
    return [];
  }

  static async findByManufacturer(_manufacturer: string): Promise<Product[]> {
    return [];
  }
}
```

**Auto-Generated REST Endpoints**:
- `GET /api/v1/products` - List all products
- `POST /api/v1/products` - Create new product
- `GET /api/v1/products/:id` - Get single product
- `PUT /api/v1/products/:id` - Update product
- ~~`DELETE /api/v1/products/:id`~~ - Excluded via decorator config

**Auto-Generated MCP Tools**:
- `list_products` - List all products (AI can query inventory)
- `get_product` - Get single product by ID (AI can lookup details)

**Auto-Generated TypeScript Types**:
```typescript
interface ProductData {
  id?: string;
  name: string;
  description?: string;
  category: string;
  manufacturer?: string;
  model?: string;
  price?: number;
  inStock?: boolean;
  specifications?: Record<string, any>;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}
```

### Category Model (src/lib/models/Category.ts)

The Category model demonstrates hierarchical relationships:

```typescript
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class Category extends SmrtObject {
  name = '';
  description = '';
  parentId?: string; // For hierarchical categories
  level = 0; // Category depth in hierarchy
  productCount = 0; // Cached count
  active = true;

  // Custom relationship methods
  async getProducts() {
    // Will be auto-implemented to fetch related products
    return [];
  }

  async getSubcategories() {
    // Will be auto-implemented to fetch child categories
    return [];
  }

  async updateProductCount(): Promise<void> {
    // Will be auto-implemented to count related products
  }

  static async getRootCategories(): Promise<Category[]> {
    // Will be auto-implemented to query top-level categories
    return [];
  }
}
```

## Svelte 5 Runes State Management

The package includes a full-featured state management store using Svelte 5's `$state` and `$derived` runes:

**Location**: `src/lib/stores/product-store.svelte.ts`

```typescript
import { createClient, type ProductData } from '../mock-smrt-client';

interface ProductStore {
  items: ProductData[];
  loading: boolean;
  error: string | null;
  selectedProduct: ProductData | null;
}

export class ProductStoreClass {
  // Reactive state using $state rune
  private data = $state<ProductStore>({
    items: [],
    loading: false,
    error: null,
    selectedProduct: null,
  });

  // Auto-generated client integration
  private api = createClient('/api/v1');

  // Reactive getters (automatically update when data changes)
  get items() { return this.data.items; }
  get loading() { return this.data.loading; }
  get error() { return this.data.error; }
  get selectedProduct() { return this.data.selectedProduct; }

  // Derived state (computed values)
  get inStockCount() {
    return this.data.items.filter((p) => p.inStock).length;
  }

  get totalValue() {
    return this.data.items.reduce(
      (sum, product) => sum + (product.price || 0),
      0,
    );
  }

  get categories() {
    const categorySet = new Set(
      this.data.items.map((p) => p.category).filter(Boolean),
    );
    return Array.from(categorySet);
  }

  // Actions (async methods that mutate state)
  async loadProducts() {
    this.data.loading = true;
    this.data.error = null;
    try {
      const response = await this.api.products.list();
      if (response.data) {
        this.data.items = response.data;
      }
    } catch (err) {
      this.data.error = err instanceof Error ? err.message : 'Failed to load';
    } finally {
      this.data.loading = false;
    }
  }

  async createProduct(productData: Partial<ProductData>) {
    this.data.loading = true;
    try {
      const response = await this.api.products.create(productData);
      if (response.data) {
        this.data.items.push(response.data); // Reactive update
      }
      return response;
    } finally {
      this.data.loading = false;
    }
  }

  async updateProduct(id: string, updates: Partial<ProductData>) {
    this.data.loading = true;
    try {
      const response = await this.api.products.update(id, updates);
      if (response.data) {
        const index = this.data.items.findIndex((p) => p.id === id);
        if (index !== -1) {
          this.data.items[index] = response.data; // Reactive update
        }
        // Update selected product if it matches
        if (this.data.selectedProduct?.id === id) {
          this.data.selectedProduct = response.data;
        }
      }
      return response;
    } finally {
      this.data.loading = false;
    }
  }

  async deleteProduct(id: string) {
    this.data.loading = true;
    try {
      await this.api.products.delete(id);
      this.data.items = this.data.items.filter((p) => p.id !== id);
      if (this.data.selectedProduct?.id === id) {
        this.data.selectedProduct = null;
      }
    } finally {
      this.data.loading = false;
    }
  }

  // Selection management
  selectProduct(product: ProductData | null) {
    this.data.selectedProduct = product;
  }

  // Filter methods (pure functions, don't mutate state)
  filterByCategory(category: string): ProductData[] {
    return this.data.items.filter((p) => p.category === category);
  }

  filterInStock(): ProductData[] {
    return this.data.items.filter((p) => p.inStock);
  }

  searchProducts(query: string): ProductData[] {
    const lowercaseQuery = query.toLowerCase();
    return this.data.items.filter(
      (product) =>
        product.name?.toLowerCase().includes(lowercaseQuery) ||
        product.description?.toLowerCase().includes(lowercaseQuery) ||
        product.tags?.some((tag) => tag.toLowerCase().includes(lowercaseQuery)),
    );
  }
}

// Export singleton instance
export const productStore = new ProductStoreClass();
```

**Key Features**:
- **Reactive State**: Uses `$state` rune for automatic UI updates
- **Derived Values**: Computed properties (inStockCount, totalValue, categories)
- **Error Handling**: Consistent error management across all operations
- **Loading States**: Tracks loading for better UX
- **CRUD Operations**: Full create, read, update, delete support
- **Search & Filter**: Client-side filtering and search capabilities
- **Selection Management**: Track currently selected product

## Virtual Module System

The SMRT framework uses Vite plugins to generate virtual modules that don't exist as physical files but are available at build time and runtime. These are auto-generated from your `@smrt()` decorated classes.

### Available Virtual Modules

```typescript
// Auto-generated TypeScript client for API calls
import createClient from '@smrt/client';

// Auto-generated TypeScript type definitions
import type { ProductData, CategoryData } from '@smrt/types';

// Auto-generated REST route setup (server-side)
import setupRoutes from '@smrt/routes';

// Auto-generated MCP tools for AI integration
import createMCPServer from '@smrt/mcp';
import { tools } from '@smrt/mcp';

// Metadata manifest (decorator configs, field info, etc.)
import { manifest } from '@smrt/manifest';
```

### How Virtual Modules Work

1. **Build-Time Generation**: During `npm run prebuild`, the `scripts/generate-smrt-types.js` script scans your models and creates type declarations in `src/lib/types/smrt-generated/`

2. **Vite Plugin Resolution**: The `smrtPlugin` and `smrtConsumer` plugins intercept imports of `@smrt/*` modules and provide the generated code

3. **Type Safety**: TypeScript gets full IntelliSense support through the generated `.d.ts` files

### Example: Using Virtual Modules

```typescript
// server.ts - Start REST API with auto-generated routes
import { createRestServer, startRestServer } from '@have/smrt';
import { Product, Category } from './lib/models';

const shutdown = await startRestServer(
  [Product, Category], // Models to generate APIs for
  {}, // context
  {
    port: 3000,
    hostname: 'localhost',
    basePath: '/api/v1',
    enableCors: true,
  },
);

// client.ts - Use auto-generated TypeScript client
import createClient from '@smrt/client';
import type { ProductData } from '@smrt/types';

const api = createClient('http://localhost:3000/api/v1');

// Fully type-safe API calls
const response = await api.products.list();
const products: ProductData[] = response.data;

const newProduct = await api.products.create({
  name: 'New Product',
  price: 29.99,
  inStock: true
});
```

## Vite Multi-Mode Configuration

The package uses a sophisticated Vite configuration that supports three build modes: **library**, **federation**, and **standalone**.

**Location**: `vite.config.ts`

### Key Configuration Points

```typescript
import { smrtPlugin } from '@have/smrt/vite-plugin';
import { smrtConsumer } from '@have/smrt/consumer-plugin';
import federation from '@originjs/vite-plugin-federation';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ command, mode }) => {
  switch (mode) {
    case 'library':
      // NPM package build with multiple entry points
      return {
        plugins: [svelte(), smrtPlugin(), smrtConsumer()],
        build: {
          lib: {
            entry: {
              index: './src/lib/index.ts',
              models: './src/lib/models/index.ts',
              components: './src/lib/components/index.ts',
              stores: './src/lib/stores/index.ts',
              generated: './src/lib/generated/index.ts',
              utils: './src/lib/utils/index.ts',
            },
            formats: ['es', 'cjs'],
          },
          outDir: 'dist/lib',
        },
      };

    case 'federation':
      // Module federation build (experimental)
      return {
        plugins: [
          svelte(),
          smrtConsumer({ staticTypes: true, disableScanning: true }),
          federation(federationConfig),
        ],
        build: { outDir: 'dist/federation' },
        server: { port: 3002 },
      };

    case 'standalone':
      // Standalone application build
      return {
        plugins: [svelte(), smrtPlugin()],
        build: {
          rollupOptions: { input: './src/app/main.ts' },
          outDir: 'dist/app',
        },
        server: { port: 3001 },
      };
  }
});
```

### SMRT Plugin Configuration

The `smrtPlugin` scans your model files and generates virtual modules:

```typescript
smrtPlugin({
  include: ['src/lib/models/**/*.ts'],      // Scan these files
  exclude: ['**/*.test.ts', '**/*.spec.ts'], // Skip test files
  baseClasses: ['SmrtObject', 'SmrtCollection'], // Look for these base classes
  generateTypes: true,                       // Generate TypeScript declarations
  watch: true,                               // Watch for file changes in dev
  hmr: true,                                 // Hot module replacement
  mode: 'server',                            // Server-side scanning
  typeDeclarationsPath: 'src/lib/types',     // Where to put .d.ts files
})
```

### SMRT Consumer Plugin Configuration

The `smrtConsumer` resolves virtual module imports:

```typescript
smrtConsumer({
  generateTypes: true,                       // Generate type declarations
  typesDir: 'src/lib/types/smrt-generated',  // Output directory
  staticTypes: false,                        // Use dynamic manifest (library mode)
  disableScanning: false,                    // Enable file scanning
})
```

## Development Workflow

### Available Scripts

```bash
# Development
npm run dev              # Start all dev servers (standalone + federation)
npm run dev:standalone   # Start standalone app server (port 3001)
npm run dev:federation   # Start federation server (port 3002)
npm run dev:library      # Build library in watch mode

# Building
npm run build            # Build all variants (lib + app + federation)
npm run build:lib        # Build NPM library package
npm run build:app        # Build standalone application
npm run build:federation # Build module federation

# Testing
npm test                 # Run tests once
npm run test:watch       # Run tests in watch mode

# Maintenance
npm run clean            # Remove dist/ and generated types
```

### Development Workflow Example

1. **Start Development Server**:
   ```bash
   npm run dev:standalone
   # Server starts on http://localhost:3001
   ```

2. **Make Changes to Models**:
   Edit `src/lib/models/Product.ts` or `Category.ts`

3. **Hot Module Replacement**:
   Changes are automatically detected and reloaded

4. **Test API Endpoints**:
   ```bash
   # List products
   curl http://localhost:3000/api/v1/products

   # Create product
   curl -X POST http://localhost:3000/api/v1/products \
     -H "Content-Type: application/json" \
     -d '{"name":"Test Product","price":29.99}'

   # Get product
   curl http://localhost:3000/api/v1/products/1

   # Update product
   curl -X PUT http://localhost:3000/api/v1/products/1 \
     -H "Content-Type: application/json" \
     -d '{"price":39.99}'
   ```

5. **Build for Production**:
   ```bash
   npm run build
   # Outputs:
   # - dist/lib/     (NPM package)
   # - dist/app/     (Standalone app)
   # - dist/federation/ (Federation bundle)
   ```

### Type Generation Flow

The package uses a prebuild script to generate TypeScript types:

1. **Prebuild Script** (`scripts/generate-smrt-types.js`):
   - Runs before every build via `npm run prebuild`
   - Scans models and creates a manifest
   - Generates `.d.ts` files in `src/lib/types/smrt-generated/`

2. **Vite Plugins**:
   - `smrtPlugin`: Provides virtual module resolution
   - `smrtConsumer`: Resolves external SMRT package imports

3. **TypeScript Integration**:
   - Generated types provide full IntelliSense
   - No runtime overhead (types are compile-time only)

## Dependencies

### Runtime Dependencies

```json
{
  "@have/smrt": "workspace:*"  // Core SMRT framework
}
```

**Why so minimal?** The package is designed as a template/example, so most dependencies are devDependencies. In a real production package, you'd add business logic dependencies here.

### Development Dependencies

```json
{
  "@originjs/vite-plugin-federation": "^1.3.8",  // Module federation
  "@sveltejs/vite-plugin-svelte": "^5.0.2",      // Svelte support
  "@types/cors": "2.8.19",                        // CORS types
  "@types/node": "^24.0.0",                       // Node.js types
  "concurrently": "^9.1.0",                       // Run multiple commands
  "svelte": "^5.18.2",                            // Svelte 5 (runes)
  "vite": "^7.1.3",                               // Build tool
  "vitest": "^3.2.4"                              // Testing framework
}
```

### Peer Dependencies

When using this package as a library, consuming applications should have:
- `@have/smrt` - Core SMRT framework
- `svelte` (if using Svelte components)
- Node.js 20+ or Bun 1.0+

## Package Exports

The package provides multiple entry points for different use cases:

```json
{
  ".": {
    "types": "./dist/lib/index.d.ts",
    "default": "./dist/lib/index.js"
  },
  "./models": {
    "types": "./dist/lib/models/index.d.ts",
    "default": "./dist/lib/models/index.js"
  },
  "./components": {
    "types": "./dist/lib/components/index.d.ts",
    "default": "./dist/lib/components/index.js"
  },
  "./stores": {
    "types": "./dist/lib/stores/index.d.ts",
    "default": "./dist/lib/stores/index.js"
  },
  "./generated": {
    "types": "./dist/lib/generated/index.d.ts",
    "default": "./dist/lib/generated/index.js"
  },
  "./utils": {
    "types": "./dist/lib/utils/index.d.ts",
    "default": "./dist/lib/utils/index.js"
  }
}
```

### Usage Examples

```typescript
// Import from main entry point
import { Product, Category, createClient } from '@have/products';

// Import specific exports
import { Product } from '@have/products/models';
import { productStore } from '@have/products/stores';
import { createClient } from '@have/products';
import type { ProductData } from '@have/products';
```

## Common Coding Patterns and Conventions

### Creating a New SMRT Model

When adding a new model to this package, follow this pattern:

```typescript
// src/lib/models/YourModel.ts
import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';

// 1. Define options interface extending SmrtObjectOptions
export interface YourModelOptions extends SmrtObjectOptions {
  name?: string;
  // Add all your properties as optional
}

// 2. Add @smrt() decorator with configuration
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'], // Exclude 'delete' for safety
  },
  mcp: {
    include: ['list', 'get'], // Only read operations for AI
  },
  cli: true, // Enable CLI commands
})
export class YourModel extends SmrtObject {
  // 3. Define properties with default values
  name = '';
  // Add more properties...

  // 4. Constructor that accepts options
  constructor(options: YourModelOptions = {}) {
    super(options);
    // Explicitly assign properties to ensure proper initialization
    this.name = options.name || '';
  }

  // 5. Add custom instance methods for business logic
  async customMethod(): Promise<void> {
    // Implementation
  }

  // 6. Add static methods for queries (will be auto-implemented by SMRT)
  static async findByName(_name: string): Promise<YourModel[]> {
    return []; // Placeholder - SMRT will implement
  }
}
```

**Key Points**:
- Always extend `SmrtObject` for SMRT functionality
- Options interface should extend `SmrtObjectOptions` (includes id, createdAt, updatedAt)
- All option properties should be optional (use `?`)
- All class properties should have default values
- Constructor must call `super(options)` first
- Static methods are for queries and will be auto-implemented by SMRT

### Integrating New Models into the API Server

After creating a model, add it to the server:

```typescript
// src/server.ts
import { YourModel } from './lib/models/YourModel';

const shutdown = await startRestServer(
  [Product, Category, YourModel], // Add your model here
  {}, // context
  {
    port: 3000,
    hostname: 'localhost',
    basePath: '/api/v1',
    enableCors: true,
  },
);
```

This automatically generates:
- `GET /api/v1/yourmodels` - List all
- `POST /api/v1/yourmodels` - Create new
- `GET /api/v1/yourmodels/:id` - Get by ID
- `PUT /api/v1/yourmodels/:id` - Update by ID

### Working with Virtual Modules

**Import Pattern**:
```typescript
// Always import from @smrt/* for virtual modules
import createClient from '@smrt/client';
import type { ProductData, CategoryData } from '@smrt/types';
import { manifest } from '@smrt/manifest';
import setupRoutes from '@smrt/routes';
import createMCPServer from '@smrt/mcp';

// Use the generated code
const api = createClient('/api/v1');
const products = await api.products.list();
```

**Troubleshooting Virtual Modules**:
- If TypeScript can't find `@smrt/*`, run `npm run prebuild`
- If changes to models aren't reflected, run `npm run clean && npm run build`
- Virtual modules are resolved by `smrtPlugin` and `smrtConsumer` in vite.config.ts
- Type declarations are generated in `src/lib/types/smrt-generated/`

### Creating Svelte 5 Components with Runes

**Component Pattern** (following ProductCard.svelte):
```svelte
<script lang="ts">
import type { ProductData } from '../types';

// Use $props rune for reactive props (Svelte 5)
interface Props {
  product: ProductData;
  onEdit?: (product: ProductData) => void;
  onDelete?: (id: string) => void;
}

const { product, onEdit, onDelete }: Props = $props();

// Use $derived for computed values
const displayPrice = $derived(
  product.price ? `$${product.price.toFixed(2)}` : 'N/A'
);

// Use $effect for side effects
$effect(() => {
  console.log('Product changed:', product.name);
});
</script>

<div class="product-card">
  <h3>{product.name}</h3>
  <p>{displayPrice}</p>

  {#if onEdit}
    <button onclick={() => onEdit?.(product)}>Edit</button>
  {/if}
</div>
```

**Key Patterns**:
- Use `$props()` instead of `export let` for props
- Use `$derived` for computed values (replaces reactive statements)
- Use `$effect()` for side effects (replaces `$:` reactive statements)
- Use `onclick` instead of `on:click` (Svelte 5 event handling)
- Optional callbacks use `?.()` for safe invocation

### Creating Svelte 5 Stores with Runes

**Store Pattern** (following product-store.svelte.ts):
```typescript
import { createClient, type ProductData } from '../mock-smrt-client';

interface StoreState {
  items: ProductData[];
  loading: boolean;
  error: string | null;
}

export class MyStoreClass {
  // Use $state for reactive data
  private data = $state<StoreState>({
    items: [],
    loading: false,
    error: null,
  });

  private api = createClient('/api/v1');

  // Getters for reactive access
  get items() { return this.data.items; }
  get loading() { return this.data.loading; }
  get error() { return this.data.error; }

  // Derived/computed values
  get itemCount() {
    return this.data.items.length;
  }

  // Async actions
  async loadItems() {
    this.data.loading = true;
    this.data.error = null;
    try {
      const response = await this.api.products.list();
      this.data.items = response.data;
    } catch (err) {
      this.data.error = err instanceof Error ? err.message : 'Error';
    } finally {
      this.data.loading = false;
    }
  }

  // Synchronous actions
  clearError() {
    this.data.error = null;
  }

  // Filter methods (pure functions, return new arrays)
  filterByTag(tag: string): ProductData[] {
    return this.data.items.filter(item =>
      item.tags?.includes(tag)
    );
  }
}

// Export singleton instance
export const myStore = new MyStoreClass();
```

**Key Patterns**:
- Store state is private and wrapped in `$state()`
- Public getters provide reactive access to state
- Actions mutate state directly (no need for `update()` function)
- Always handle errors in try/catch blocks
- Use `finally` to reset loading states
- Filter methods should be pure functions that return new arrays
- Export a singleton instance for easy import

### Using Stores in Svelte Components

```svelte
<script>
  import { myStore } from '../stores';

  // Load data on mount
  $effect(() => {
    myStore.loadItems();
  });

  // Access reactive state via getters
  const items = $derived(myStore.items);
  const loading = $derived(myStore.loading);
  const error = $derived(myStore.error);

  async function handleCreate() {
    await myStore.createItem({ name: 'New Item' });
  }
</script>

{#if loading}
  <p>Loading...</p>
{:else if error}
  <p class="error">{error}</p>
{:else}
  <ul>
    {#each items as item}
      <li>{item.name}</li>
    {/each}
  </ul>
{/if}
```

## Best Practices and Guidelines

### SMRT Model Development

**DO**:
- ✅ Use clear, descriptive property names that map to your domain
- ✅ Add JSDoc comments to properties for better documentation
- ✅ Use TypeScript interfaces for constructor options (extend `SmrtObjectOptions`)
- ✅ Configure `@smrt()` decorator to expose only needed operations
- ✅ Add custom business logic methods to your models
- ✅ Use meaningful default values for properties
- ✅ Explicitly assign properties in constructor (don't rely on Object.assign)
- ✅ Keep static methods as placeholders (return empty arrays) - SMRT will implement them

**DON'T**:
- ❌ Don't make all properties optional (defeats type safety)
- ❌ Don't expose dangerous operations (like `delete`) to MCP without thought
- ❌ Don't skip the constructor pattern (makes testing harder)
- ❌ Don't use any types (defeats the purpose of TypeScript)
- ❌ Don't forget to add new models to `startRestServer()` array
- ❌ Don't mutate state outside of store actions

### Svelte 5 Runes Patterns

**DO**:
- ✅ Use `$state` for reactive data that changes
- ✅ Use getters for derived computed values
- ✅ Use `$derived` in components for reactive expressions
- ✅ Use `$effect` for side effects (like API calls on mount)
- ✅ Keep stores as class instances with methods

**DON'T**:
- ❌ Don't mutate state directly without proper reactivity
- ❌ Don't use Svelte 4 patterns (stores, readable, writable)
- ❌ Don't put complex logic in templates
- ❌ Don't forget error handling in async store methods

### State Management Best Practices

```typescript
// ✅ GOOD: Clear separation of concerns
export class ProductStoreClass {
  private data = $state({ items: [], loading: false, error: null });

  get items() { return this.data.items; }
  get loading() { return this.data.loading; }

  async loadProducts() {
    this.data.loading = true;
    this.data.error = null;
    try {
      const response = await this.api.products.list();
      this.data.items = response.data;
    } catch (err) {
      this.data.error = err.message;
    } finally {
      this.data.loading = false;
    }
  }
}

// ❌ BAD: Exposing internal state directly
export class BadStore {
  data = $state({ items: [] }); // Don't expose directly!
}
```

### Virtual Module Gotchas

**Important Notes**:

1. **Prebuild Required**: Always run `npm run prebuild` before building if types are missing
2. **Virtual Module Imports**: Imports from `@smrt/*` don't exist as physical files
3. **Type Generation**: Types are generated at build time, not runtime
4. **Plugin Order Matters**: `smrtPlugin` must come before `smrtConsumer` in Vite config
5. **Mode-Specific Behavior**: Different build modes use different plugin configurations

### Common Issues and Solutions

#### Virtual Module Issues

**Issue**: `Cannot find module '@smrt/client'` or other `@smrt/*` imports
```bash
# Solution: Run prebuild to generate types
npm run prebuild

# If that doesn't work, clean and rebuild
npm run clean
npm run prebuild
npm run build
```

**Cause**: The `@smrt/*` virtual modules are generated by Vite plugins at build time. If the prebuild script hasn't run, TypeScript won't find the type declarations.

**Issue**: Virtual modules not resolving in IDE (red squiggles but builds fine)
```bash
# Solution: Restart TypeScript server in your IDE
# VS Code: Cmd+Shift+P → "TypeScript: Restart TS Server"
# Or close and reopen the project
```

**Cause**: IDEs cache TypeScript declarations. When new types are generated, the IDE needs to reload.

**Issue**: Changes to models not reflected in API/types
```bash
# Solution: Clean and rebuild
npm run clean
npm run build

# Or just regenerate types
npm run prebuild
```

**Cause**: Generated types are cached in `src/lib/types/smrt-generated/`. Changes to models require regeneration.

#### Svelte 5 Runes Issues

**Issue**: Type errors with `$state` rune
```typescript
// ❌ Error: Cannot find name '$state'
const data = $state({ items: [] });

// Solution: Make sure you're using Svelte 5.x
// Check package.json: "svelte": "^5.18.2"
// Ensure file has .svelte.ts extension (not just .ts)
```

**Cause**: The `$state` rune is only available in Svelte 5 and only in `.svelte.ts` files (or `.svelte` files).

**Issue**: `$state` not reactive in components
```svelte
<!-- ❌ Not reactive -->
<script>
  const store = $state({ count: 0 });
</script>

<!-- ✅ Reactive - use store class pattern -->
<script>
  import { myStore } from './stores';
  const count = $derived(myStore.count);
</script>
```

**Cause**: `$state` in component scripts doesn't persist across rerenders. Use store classes for persistent reactive state.

**Issue**: Props not updating (using old Svelte 4 syntax)
```svelte
<!-- ❌ Svelte 4 syntax (doesn't work in Svelte 5) -->
<script>
  export let product;
</script>

<!-- ✅ Svelte 5 syntax -->
<script lang="ts">
  interface Props {
    product: ProductData;
  }
  const { product }: Props = $props();
</script>
```

**Cause**: Svelte 5 uses `$props()` rune instead of `export let` for component props.

#### Build and Configuration Issues

**Issue**: Build fails with "Cannot find module @have/smrt"
```bash
# Solution: Make sure @have/smrt is built first
cd ../smrt
npm run build
cd ../products
npm run build
```

**Cause**: The products package depends on @have/smrt. Build order matters in monorepos.

**Issue**: Module federation build fails
```bash
# Solution: Use static types for federation builds
# Already configured in vite.config.ts for federation mode:
smrtConsumer({
  generateTypes: true,
  typesDir: 'src/lib/types/smrt-generated',
  staticTypes: true,        # Uses pre-generated types
  disableScanning: true,    # No runtime scanning
})
```

**Cause**: Module federation can't handle dynamic module scanning. Must use pre-generated static types.

**Issue**: Dev server not picking up model changes
```bash
# Solution: Stop dev server and restart
# Ctrl+C to stop
npm run dev:standalone

# Or clean and restart
npm run clean
npm run dev:standalone
```

**Cause**: HMR (hot module replacement) doesn't always catch decorator changes. Full restart required.

#### Runtime Issues

**Issue**: API endpoints return 404
```bash
# Check: Is the server running?
curl http://localhost:3000/api/v1/products

# Check: Did you add the model to startRestServer()?
# src/server.ts
const shutdown = await startRestServer(
  [Product, Category], // Add your model here
  // ...
);
```

**Cause**: Models must be explicitly registered with `startRestServer()` to generate endpoints.

**Issue**: MCP tools not showing up
```typescript
// Check the decorator configuration
@smrt({
  mcp: {
    include: ['list', 'get'], // Ensure operations are included
  },
})
```

**Cause**: MCP tools are only generated for operations included in the `@smrt()` decorator's `mcp` config.

**Issue**: CORS errors when accessing API from frontend
```typescript
// Solution: Enable CORS in server options
const shutdown = await startRestServer(
  [Product, Category],
  {},
  {
    port: 3000,
    hostname: 'localhost',
    basePath: '/api/v1',
    enableCors: true, // Add this
  },
);
```

**Cause**: Browser blocks cross-origin requests by default. Server must explicitly enable CORS.

#### Type Safety Issues

**Issue**: Type mismatches between model and generated types
```bash
# Solution: Regenerate types after model changes
npm run prebuild

# If still failing, check scripts/generate-smrt-types.js
# Ensure the manifest matches your model properties
```

**Cause**: Generated types in `scripts/generate-smrt-types.js` may be out of sync with actual model properties.

**Issue**: Optional properties causing type errors
```typescript
// ❌ TypeScript error: Property 'price' may be undefined
const total = product.price * quantity;

// ✅ Use optional chaining or default value
const total = (product.price ?? 0) * quantity;
const total = product.price ? product.price * quantity : 0;
```

**Cause**: Optional properties need null/undefined checks. Use `??` or `?` operators.

### Important Gotchas

#### 1. Constructor Property Assignment

**Gotcha**: Using `Object.assign(this, options)` doesn't work with decorators
```typescript
// ❌ DON'T DO THIS (might not work with decorators)
constructor(options: ProductOptions = {}) {
  super(options);
  Object.assign(this, options);
}

// ✅ DO THIS (explicit assignment)
constructor(options: ProductOptions = {}) {
  super(options);
  this.name = options.name || '';
  this.price = options.price || 0;
  // ... assign each property explicitly
}
```

**Why**: Decorators may intercept property access. Explicit assignment ensures proper initialization.

#### 2. Static Method Placeholders

**Gotcha**: Static methods must return the correct type even as placeholders
```typescript
// ❌ DON'T DO THIS (wrong return type)
static async findByName(_name: string) {
  // Will be implemented by SMRT
}

// ✅ DO THIS (correct return type)
static async findByName(_name: string): Promise<Product[]> {
  return []; // Placeholder - SMRT will replace this
}
```

**Why**: TypeScript needs the correct return type for type checking. SMRT will replace the implementation but not the signature.

#### 3. Virtual Module Timing

**Gotcha**: Virtual modules are only available after prebuild
```typescript
// ❌ This will fail in tests/scripts without prebuild
import createClient from '@smrt/client';

// ✅ Either run prebuild first, or use mock client
import { createClient } from '../lib/mock-smrt-client';
```

**Why**: Virtual modules don't exist until the prebuild script generates type declarations. Use mocks for testing.

#### 4. Store Reactivity Scope

**Gotcha**: Store changes only reactive within Svelte components
```typescript
// ❌ This won't be reactive outside Svelte components
const items = store.items; // Gets current value once
console.log(items); // Won't update when store changes

// ✅ Access via getter inside component
const items = $derived(store.items); // Reactive in Svelte component
```

**Why**: Svelte's reactivity only works within Svelte component contexts. Outside components, getters just return current values.

#### 5. Model Collection Names

**Gotcha**: Collection names are auto-pluralized and may not match expectations
```typescript
// Model class: Product
// API endpoint: /api/v1/products (auto-pluralized)
// MCP tool: list_products (auto-pluralized)

// Model class: Category
// API endpoint: /api/v1/categories (auto-pluralized correctly)
// MCP tool: list_categories

// If you need custom collection name, use decorator:
@smrt({
  collection: 'items', // Custom collection name
})
class Product extends SmrtObject {}
// API endpoint: /api/v1/items
```

**Why**: SMRT auto-pluralizes class names for endpoints. For non-standard pluralization, override with `collection` option.

#### 6. Svelte 5 Event Handling

**Gotcha**: Event handlers changed in Svelte 5
```svelte
<!-- ❌ Svelte 4 syntax (doesn't work) -->
<button on:click={handleClick}>Click</button>

<!-- ✅ Svelte 5 syntax -->
<button onclick={handleClick}>Click</button>

<!-- ✅ Inline arrow function -->
<button onclick={() => handleClick(item)}>Click</button>
```

**Why**: Svelte 5 uses standard DOM event attributes (`onclick`, `onchange`) instead of `on:` directives.

#### 7. Build Mode Confusion

**Gotcha**: Different build modes require different configurations
```bash
# Library build - for NPM package (most common)
npm run build:lib
# Uses: smrtPlugin + smrtConsumer (dynamic)
# Output: dist/lib/

# Federation build - for module federation
npm run build:federation
# Uses: smrtConsumer only (static types)
# Output: dist/federation/

# Standalone build - for standalone app
npm run build:app
# Uses: smrtPlugin (scanning enabled)
# Output: dist/app/
```

**Why**: Each build mode has different requirements for how virtual modules are resolved. Using the wrong mode can cause build failures.

### Testing Recommendations

Currently, the package has minimal test coverage. When adding tests:

1. **Model Tests**: Test SMRT model constructors and custom methods
   ```typescript
   test('Product constructor sets properties', () => {
     const product = new Product({ name: 'Test', price: 29.99 });
     expect(product.name).toBe('Test');
     expect(product.price).toBe(29.99);
   });
   ```

2. **Store Tests**: Test state management logic
   ```typescript
   test('productStore filters by category', () => {
     const electronics = productStore.filterByCategory('Electronics');
     expect(electronics.every(p => p.category === 'Electronics')).toBe(true);
   });
   ```

3. **API Integration Tests**: Test generated endpoints (requires running server)
   ```typescript
   test('GET /api/v1/products returns array', async () => {
     const response = await fetch('http://localhost:3000/api/v1/products');
     const data = await response.json();
     expect(Array.isArray(data)).toBe(true);
   });
   ```

### Performance Considerations

- **Bundle Size**: Library build generates ES + CJS formats for tree-shaking
- **Code Splitting**: Vite automatically splits chunks for optimal loading
- **Virtual Modules**: No runtime overhead (resolved at build time)
- **Runes**: Svelte 5 runes are more performant than Svelte 4 stores
- **API Calls**: Store includes loading states to prevent duplicate requests

### Migration from Svelte 4

If adapting this template for Svelte 4:

```typescript
// Svelte 5 (current)
export class Store {
  private data = $state({ items: [] });
  get items() { return this.data.items; }
}

// Svelte 4 equivalent
import { writable, derived } from 'svelte/store';
export const items = writable([]);
export const itemCount = derived(items, $items => $items.length);
```

## Key Documentation Links

Reference these when working with the package:

### SMRT Framework
- **@have/smrt package**: Core framework documentation (see `/packages/smrt/CLAUDE.md`)
- **SMRT Vite Plugin**: Virtual module generation (see `/packages/smrt/src/vite-plugin/`)
- **SMRT Consumer Plugin**: External package consumption (see `/packages/smrt/src/consumer-plugin/`)

### Svelte 5
- **Svelte 5 Runes**: https://svelte.dev/docs/svelte/what-are-runes
  - `$state`, `$derived`, `$effect` documentation
  - Migration guide from Svelte 4
- **Svelte 5 Release Notes**: https://svelte.dev/blog/svelte-5-release-candidate

### Build Tools
- **Vite Configuration**: https://vitejs.dev/config/
  - Library mode: https://vitejs.dev/guide/build.html#library-mode
  - Plugin API: https://vitejs.dev/guide/api-plugin.html
- **Vitest**: https://vitest.dev/guide/
  - Testing patterns and best practices

### Module Federation (Experimental)
- **@originjs/vite-plugin-federation**: https://github.com/originjs/vite-plugin-federation
  - Configuration reference
  - Known issues and limitations

## Quick Start Guide

### For Template Users (Creating New Microservice)

1. **Copy the template**:
   ```bash
   cp -r packages/products packages/your-service
   cd packages/your-service
   ```

2. **Update package.json**:
   ```json
   {
     "name": "@have/your-service",
     "description": "Your service description"
   }
   ```

3. **Create your models**:
   ```typescript
   // src/lib/models/YourModel.ts
   import { SmrtObject, smrt } from '@have/smrt';

   @smrt({ api: { include: ['list', 'get', 'create'] } })
   export class YourModel extends SmrtObject {
     name = '';
     // Add your properties
   }
   ```

4. **Generate types and build**:
   ```bash
   npm run prebuild
   npm run build
   ```

5. **Start development**:
   ```bash
   npm run dev:standalone
   ```

### For Library Consumers (Using as NPM Package)

```bash
npm install @have/products
```

```typescript
import { Product, createClient } from '@have/products';
import { productStore } from '@have/products/stores';

// Use models
const product = new Product({ name: 'Test', price: 29.99 });

// Use API client
const api = createClient('/api/v1');
const products = await api.products.list();

// Use store in Svelte components
import { productStore } from '@have/products/stores';
```

## Quick Reference Cheat Sheet

### Essential Commands

```bash
# Development
npm run dev:standalone      # Start standalone dev server (port 3001)
npm run dev:federation      # Start federation dev server (port 3002)
npm run dev:library         # Watch mode for library development

# Building
npm run prebuild            # Generate type declarations (run before build)
npm run build               # Build all variants (lib + app + federation)
npm run build:lib           # Build NPM library package only
npm run clean               # Remove dist/ and generated types

# Testing
npm test                    # Run tests once
npm run test:watch          # Run tests in watch mode

# Troubleshooting
npm run clean && npm run prebuild && npm run build  # Full rebuild
```

### File Locations Quick Reference

```
Key Configuration Files:
├── vite.config.ts                      # Multi-mode Vite configuration
├── scripts/generate-smrt-types.js      # Type generation script
└── package.json                        # Scripts and dependencies

Key Source Files:
├── src/lib/models/Product.ts           # Example SMRT model
├── src/lib/stores/product-store.svelte.ts  # Example Svelte 5 store
├── src/lib/components/ProductCard.svelte   # Example Svelte 5 component
├── src/server.ts                       # REST API server setup
├── src/mcp.ts                          # MCP server setup
└── src/lib/mock-smrt-client.ts         # Mock client for development

Generated Files (don't edit):
└── src/lib/types/smrt-generated/       # Auto-generated type declarations
```

### Decorator Configuration Quick Reference

```typescript
@smrt({
  // API configuration
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'], // Which endpoints to generate
    exclude: ['delete'], // Which endpoints to skip
  },

  // MCP tools configuration
  mcp: {
    include: ['list', 'get'], // Which tools to expose to AI
    exclude: ['create', 'update', 'delete'], // Which tools to hide
  },

  // CLI configuration
  cli: true, // Enable CLI commands

  // Custom collection name (optional)
  collection: 'items', // Override auto-pluralization
})
```

### Virtual Module Imports Quick Reference

```typescript
// Virtual modules (require prebuild)
import createClient from '@smrt/client';
import type { ProductData, CategoryData } from '@smrt/types';
import { manifest } from '@smrt/manifest';
import setupRoutes from '@smrt/routes';
import createMCPServer, { tools } from '@smrt/mcp';

// Real modules (always available)
import { Product, Category } from '@have/products/models';
import { productStore } from '@have/products/stores';
import { ProductCard } from '@have/products/components';
```

### Svelte 5 Runes Quick Reference

```typescript
// State management
const data = $state({ items: [], loading: false });  // Reactive state

// Computed values
const count = $derived(data.items.length);           // Auto-recomputes

// Props in components
const { product, onEdit }: Props = $props();         // Component props

// Side effects
$effect(() => {
  console.log('Items changed:', data.items);
});
```

### API Endpoints Quick Reference

```bash
# Auto-generated for Product model
GET    /api/v1/products        # List all products
POST   /api/v1/products        # Create new product
GET    /api/v1/products/:id    # Get product by ID
PUT    /api/v1/products/:id    # Update product
DELETE /api/v1/products/:id    # Delete product (if included in decorator)

# Auto-generated for Category model
GET    /api/v1/categories      # List all categories
POST   /api/v1/categories      # Create new category
GET    /api/v1/categories/:id  # Get category by ID
PUT    /api/v1/categories/:id  # Update category
```

### Common Error Messages and Quick Fixes

```
Error: Cannot find module '@smrt/client'
→ Run: npm run prebuild

Error: Port 3000 already in use
→ Kill existing process or change port in server.ts

Error: Cannot find name '$state'
→ Check file extension is .svelte.ts (not just .ts)

Error: Module not found: @have/smrt
→ Build smrt package first: cd ../smrt && npm run build

Type error: Property 'price' may be undefined
→ Use optional chaining: product.price ?? 0
```

## Summary

The `@have/products` package is a **reference implementation** and **template** demonstrating:

1. **SMRT Framework Capabilities**: Auto-generation of REST APIs, TypeScript clients, and MCP tools from decorated classes
2. **Svelte 5 Patterns**: Modern reactive state management using runes (`$state`, `$derived`, `$effect`, `$props`)
3. **Multi-Mode Build**: Support for library, federation, and standalone builds from one codebase
4. **Virtual Module System**: Vite plugins that generate code at build time
5. **Type Safety**: Full TypeScript support with auto-generated type definitions

**Primary Use Case**: Use as a starting point for building your own SMRT-based microservices with auto-generated APIs and type-safe clients.

**Production Readiness**: The REST API server and TypeScript client generation are production-ready. Module federation and UI components are experimental.

**Key Files for Learning**:
1. `/Users/will/Work/happyvertical/repos/sdk/packages/products/src/lib/models/Product.ts` - Complete SMRT model example
2. `/Users/will/Work/happyvertical/repos/sdk/packages/products/src/server.ts` - REST API server setup
3. `/Users/will/Work/happyvertical/repos/sdk/packages/products/src/lib/stores/product-store.svelte.ts` - Svelte 5 store pattern
4. `/Users/will/Work/happyvertical/repos/sdk/packages/products/vite.config.ts` - Multi-mode build configuration

**When Making Changes**:
1. Models → Run `npm run prebuild` to regenerate types
2. Store/Components → Changes are picked up by HMR automatically
3. Vite config → Restart dev server
4. Dependencies → Run `npm install` and rebuild