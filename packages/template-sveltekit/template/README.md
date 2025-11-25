# SMRT SvelteKit App

A SvelteKit application with SMRT framework integration for rapid development of AI-powered applications.

## Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment**:
   ```bash
   cp .env.example .env
   ```

3. **Start development server**:
   ```bash
   npm run dev
   ```

4. **Initialize database** (optional):
   ```bash
   smrt db:setup
   ```

## Project Structure

```
├── src/
│   ├── lib/
│   │   ├── objects/     # SMRT objects (auto-generates API routes)
│   │   │   ├── index.ts # Export all objects here
│   │   │   └── Item.ts  # Example SMRT object
│   │   └── server/
│   │       └── smrt.ts  # SMRT configuration
│   └── routes/
│       ├── api/         # Auto-generated API routes (don't edit!)
│       └── +page.svelte # Home page
├── smrt.config.ts       # Root SMRT config
├── vite.config.ts       # Vite + SMRT plugin config
└── svelte.config.js     # SvelteKit config
```

## Creating SMRT Objects

1. Create a new file in `src/lib/objects/`:

```typescript
// src/lib/objects/Product.ts
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
})
export class Product extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  description: string = '';
  active: boolean = true;
}
```

2. Export it from `src/lib/objects/index.ts`:

```typescript
export { Item } from './Item.js';
export { Product } from './Product.js';
```

3. Run `npm run dev` - API routes are auto-generated!

## CLI Commands

```bash
# List discovered SMRT objects
smrt objects

# View object details
smrt introspect

# Initialize database tables
smrt db:setup

# Regenerate API routes
smrt generate-routes

# Run operations on objects
smrt item list
smrt item get <id>
```

## API Endpoints

For each SMRT object, the following endpoints are auto-generated:

- `GET /api/{collection}` - List all items
- `GET /api/{collection}/[id]` - Get single item
- `POST /api/{collection}` - Create new item
- `PUT /api/{collection}/[id]` - Update item
- `DELETE /api/{collection}/[id]` - Delete item

Custom methods are exposed as:
- `POST /api/{collection}/[id]/{method}` - Call custom method

## Learn More

- [SMRT Framework Documentation](https://github.com/happyvertical/smrt)
- [SvelteKit Documentation](https://kit.svelte.dev/)
