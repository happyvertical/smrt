# SMRT Template: Triple-Purpose Microservice Foundation

> **One codebase, three consumption patterns: Standalone app, federated modules, and NPM library.**

This template demonstrates how to build sophisticated microservices with the SMRT framework that can be consumed in multiple ways without maintaining separate codebases.

## 🚀 Quick Start

```bash
# Clone and setup
git clone <repo> && cd smrt-template
npm install

# Start development (all modes simultaneously)
npm run dev
# Standalone app: http://localhost:3001
# Federation server: http://localhost:3002
```

## 🎯 Three Ways to Use This Service

### 1. 🏗️ Standalone Application
Complete, independent web application with full UI and functionality.

```bash
npm run dev:standalone
# or
docker run -p 3001:3001 product-service
```

### 2. 🔗 Module Federation Provider
Runtime component sharing - other applications can import components dynamically.

```javascript
// Consumer application
import ProductCard from 'productService/ProductCard';
import ProductCatalog from 'productService/ProductCatalog';
```

### 3. 📦 NPM Package Library
Traditional build-time imports for maximum optimization.

```bash
npm install @have/smrt-template
```

```javascript
// Consumer application  
import { Product, ProductCard } from '@have/smrt-template';
import { productStore } from '@have/smrt-template/stores';
```

## ✨ What's Auto-Generated

The SMRT framework automatically generates from your `@smrt()` decorated classes:

- **🌐 REST APIs** - Full CRUD endpoints with OpenAPI docs
- **🤖 MCP Tools** - AI model integration tools (Claude, GPT, etc.)  
- **📝 TypeScript Client** - Fully typed API client
- **🎨 UI Components** - React/Svelte components (planned)
- **📋 Type Definitions** - Complete TypeScript declarations

## 📁 Project Structure

```
src/
├── lib/                    # 📦 Library exports (NPM package)
│   ├── models/             # @smrt() decorated classes  
│   ├── components/         # UI components (Svelte 5)
│   ├── stores/             # Reactive state (runes)
│   └── generated/          # Auto-generated components
├── app/                    # 🏗️ Standalone application
│   ├── pages/              # Complete pages
│   ├── layouts/            # App layouts  
│   └── main.ts             # App entry point
└── federation/             # 🔗 Module federation config
    ├── expose.config.ts    # What this service exposes
    └── consume.config.ts   # What this service consumes
```

## 🛠️ Development Commands

```bash
# Development
npm run dev              # All modes simultaneously
npm run dev:standalone   # Standalone app only
npm run dev:federation   # Federation server only

# Building  
npm run build           # All build variants
npm run build:lib       # NPM package
npm run build:app       # Standalone application
npm run build:federation # Module federation

# Testing
npm test               # Run tests
npm run test:watch     # Watch mode

# Production
npm start              # Start standalone app
npm run start:federation # Start federation server
```

## 🎯 How It Works

### 1. AST Scanning

The SMRT Vite plugin scans your TypeScript files at build time and extracts metadata from `@smrt()` decorated classes:

```typescript
// vite.config.ts
import { smrtPlugin } from '@have/smrt';

export default defineConfig({
  plugins: [
    smrtPlugin({
      include: ['src/**/*.ts'],
      baseClasses: ['SmrtObject', 'SmrtCollection']
    })
  ]
});
```

### 2. Virtual Modules

The plugin generates virtual modules that you can import:

```typescript
import setupRoutes from '@smrt/routes';      // Auto-generated REST routes
import createClient from '@smrt/client';     // Auto-generated TypeScript client
import createMCPServer from '@smrt/mcp';     // Auto-generated MCP tools
import { manifest } from '@smrt/manifest';   // Object metadata
import type * from '@smrt/types';            // Auto-generated TypeScript types
```

### 3. Live Updates

As you modify your SMRT objects, the services update automatically:
- Add a new field → REST API and client automatically support it
- Add a new `@smrt()` class → New endpoints and tools are generated
- Change decorator config → API behavior updates instantly

## 📁 Project Structure

```
src/
├── models.ts          # SMRT domain objects (Product, Category)
├── server.ts          # REST API server using auto-generated routes
├── client.ts          # Demo of auto-generated TypeScript client
├── mcp.ts             # MCP server with auto-generated tools
├── index.ts           # Main entry point and demo orchestration
└── vite.config.ts     # Vite configuration with SMRT plugin
```

## 🔧 Customization

### Object Configuration

Control what gets generated for each object:

```typescript
@smrt({
  api: {
    exclude: ['delete'],        // Don't generate DELETE endpoint
    include: ['list', 'create'] // Only generate these endpoints
  },
  mcp: {
    include: ['list', 'get']    // Only expose these as AI tools
  },
  cli: true                     // Enable CLI commands
})
class MyObject extends SmrtObject {
  // ... fields
}
```

### Field Types

SMRT automatically infers field types and generates appropriate validation:

```typescript
class Product extends SmrtObject {
  name: string = '';           // → text field, required
  description?: string;        // → text field, optional
  price: number = 0;          // → decimal field, required
  inStock: boolean = true;    // → boolean field, required
  tags: string[] = [];        // → json field, required
}
```

## 🌟 Key Benefits

1. **Zero Boilerplate**: No manual route definitions or client code
2. **Type Safety**: Full TypeScript support across generated code
3. **Live Development**: Changes reflect immediately during development
4. **Consistent APIs**: All services follow the same patterns
5. **AI Integration**: MCP tools work out of the box with AI models
6. **Scalable**: Add new objects and services scale automatically

## 🚀 Try It Out

1. **Start the demo**: `bun run start`
2. **Make a request**: `curl http://localhost:3000/api/v1/products`
3. **Modify `src/models.ts`**: Add a new field to Product
4. **Watch it update**: The API automatically supports your new field

## 🎨 UI Components

Built with **Svelte 5** using the new runes system:

### ProductCard.svelte
```svelte
<script lang="ts">
  import type { ProductData } from '@smrt/types';
  
  interface Props {
    product: ProductData;
    onEdit?: (product: ProductData) => void;
    onDelete?: (id: string) => void;
  }
  
  let { product, onEdit, onDelete }: Props = $props();
</script>

<div class="product-card">
  <h3>{product.name}</h3>
  <p>${product.price}</p>
  <!-- Auto-styled, accessible component -->
</div>
```

### Reactive Stores (Svelte 5 Runes)
```typescript  
export class ProductStoreClass {
  private data = $state<ProductStore>({
    items: [],
    loading: false,
    error: null
  });

  // Reactive getters
  get items() { return this.data.items; }
  get inStockCount() {
    return this.data.items.filter(p => p.inStock).length;
  }

  // Auto-generated API integration
  async loadProducts() {
    const response = await api.products.list();
    this.data.items = response.data;
  }
}
```

## 🔧 SMRT Models

Define your domain objects with decorators:

```typescript
// src/lib/models/Product.ts
import { SmrtObject } from '@have/smrt';

@smrt({
  api: { exclude: ['delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true
})
export class Product extends SmrtObject {
  name: string = '';
  description?: string;
  price: number = 0;
  inStock: boolean = true;
  category: string = '';
  tags: string[] = [];

  async calculateDiscount(percentage: number): Promise<number> {
    return this.price * (percentage / 100);
  }
}
```

This automatically generates:
- `GET /api/v1/products` - List products
- `POST /api/v1/products` - Create product  
- `GET /api/v1/products/:id` - Get product
- `PUT /api/v1/products/:id` - Update product
- MCP tools for AI integration
- TypeScript client methods
- Full type definitions

## 🔗 Module Federation Examples

### Expose Components (This Service)

```typescript
// Automatically configured via federation/expose.config.ts
exposes: {
  // Components
  './ProductCard': './src/lib/components/ProductCard.svelte',
  './ProductForm': './src/lib/components/ProductForm.svelte',
  
  // Features  
  './ProductCatalog': './src/lib/features/ProductCatalog.svelte',
  
  // Pages
  './ProductsPage': './src/app/pages/ProductsPage.svelte',
  
  // Business Logic
  './Product': './src/lib/models/Product.ts',
  './ProductStore': './src/lib/stores/product-store.svelte.ts'
}
```

### Consume Components (Other Services)

```svelte
<!-- In another application -->
<script>
  // Runtime imports from federation
  import ProductCatalog from 'productService/ProductCatalog';  
  import UserProfile from 'userService/UserProfile';
  import OrderHistory from 'orderService/OrderHistory';
</script>

<!-- Compose application from multiple services -->
<div class="dashboard">
  <UserProfile userId={currentUser.id} />
  <ProductCatalog readonly={true} />
  <OrderHistory userId={currentUser.id} />
</div>
```

## 🚢 Deployment Options

### Docker (Standalone)
```dockerfile  
FROM node:24-alpine
WORKDIR /app
COPY dist/app .
EXPOSE 3001
CMD ["npx", "serve", "-s", ".", "-l", "3001"]
```

### NPM Registry
```bash
# Publish as package
npm run build:lib
npm publish
```

## 🤖 AI Integration (MCP)

The SMRT framework automatically creates MCP (Model Context Protocol) tools:

```bash
# Start MCP server
npm run start:mcp

# Available tools for Claude/GPT:
# - list_products
# - get_product  
# - create_product
# - calculate_product_discount
```

Example AI interaction:
```
Human: Show me all products under $50

Claude: I'll help you find products under $50.

<uses list_products tool>

Here are the products under $50:
- Demo Product: $29.99 (in stock)
- Budget Item: $19.99 (out of stock)
```

## 📚 Documentation

- **[Architecture Guide](docs/ARCHITECTURE.md)** - Detailed technical architecture
- **[Federation Guide](docs/FEDERATION_GUIDE.md)** - Module federation patterns  
- **[Deployment Modes](docs/DEPLOYMENT_MODES.md)** - All deployment options

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes in `src/lib/` for library features
4. Add corresponding federation exports if needed
5. Update documentation
6. Submit a pull request

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

**Built with SMRT** - The framework that transforms decorated classes into full-stack applications with REST APIs, AI tools, and modern UIs.

**Powered by Svelte 5** - Modern reactive UI with runes-based state management.

**Federation Ready** - Share components and features across microservices at runtime.

*<small>Shop smart, shop s.m.r.t .. I mean s.m.a.r.t</small>*