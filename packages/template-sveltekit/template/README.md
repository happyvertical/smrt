# SMRT SvelteKit App

A SvelteKit application with SMRT framework integration for rapid development of AI-powered, multi-tenant applications.

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
│   ├── hooks.server.ts        # Auth + tenancy wiring (see "Multi-tenancy" below)
│   ├── lib/
│   │   ├── objects/           # SMRT objects (auto-generates API routes)
│   │   │   ├── index.ts       # Export all objects here
│   │   │   └── Item.ts        # Example SMRT object
│   │   └── server/
│   │       ├── smrt.ts        # SMRT configuration
│   │       └── tenancy.ts     # Pluggable tenant resolver
│   └── routes/
│       ├── api/               # Auto-generated API routes (don't edit!)
│       └── +page.svelte       # Home page
├── smrt.config.ts             # Root SMRT config
├── vite.config.ts             # Vite + SMRT plugin config
└── svelte.config.js           # SvelteKit config
```

## Multi-tenancy

This template ships with multi-tenancy pre-wired. Out of the box you get:

- **Session loading + auth** via `createSessionHandler({ enterTenantContext: true })` from `@happyvertical/smrt-users/sveltekit`. After the hook runs, `event.locals` carries `{ user, permissions, tenantId, sessionId }`.
- **Auto-scoped REST routes**. The tenancy interceptor is registered globally (`enableTenancy()` in `hooks.server.ts`), so any model decorated with `@TenantScoped()` is filtered by the current tenant in `AsyncLocalStorage`. The generated `src/routes/api/**` endpoints inherit this automatically.
- **Subdomain-based tenant resolution**. By default, the leading subdomain is the tenant slug:

  | URL | Tenant ID |
  |---|---|
  | `https://acme.demo.local/dashboard` | `acme` |
  | `https://www.demo.local/` | `null` (reserved) |
  | `https://demo.local/` | `null` (no subdomain) |
  | `http://localhost:5173/` | `null` (root-like host) |

### Local development DNS

Browsers won't resolve subdomains of `demo.local` to your dev server automatically. Pick one:

**Option A — `/etc/hosts` (simplest, fixed list)**

```
127.0.0.1   demo.local
127.0.0.1   acme.demo.local
127.0.0.1   shop.acme.demo.local
```

**Option B — `dnsmasq` (wildcard, recommended)**

```bash
# macOS
brew install dnsmasq
echo 'address=/demo.local/127.0.0.1' | sudo tee -a $(brew --prefix)/etc/dnsmasq.conf
sudo brew services restart dnsmasq
# Tell macOS to use dnsmasq for `.local` queries
sudo mkdir -p /etc/resolver
echo 'nameserver 127.0.0.1' | sudo tee /etc/resolver/local
```

After either, hit `http://acme.demo.local:5173/` and the tenant will resolve to `acme`.

### Swapping the resolution strategy

`src/lib/server/tenancy.ts` exposes three built-in strategies plus a `createTenantResolver()` factory. Pick whichever matches your routing:

```ts
// Subdomain (default)
import {
  createTenantResolver,
  subdomainStrategy,
} from '$lib/server/tenancy';
export const resolveTenant = createTenantResolver(subdomainStrategy);

// Path prefix:  /t/<slug>/...
import {
  createTenantResolver,
  pathPrefixStrategy,
} from '$lib/server/tenancy';
export const resolveTenant = createTenantResolver(pathPrefixStrategy());

// Custom prefix:  /tenant/<slug>/...
export const resolveTenant = createTenantResolver(
  pathPrefixStrategy({ prefix: '/tenant/' }),
);

// HTTP header:  x-tenant-id: acme
import {
  createTenantResolver,
  headerStrategy,
} from '$lib/server/tenancy';
export const resolveTenant = createTenantResolver(headerStrategy());

// Compose:  try subdomain, fall back to header
import {
  createTenantResolver,
  headerStrategy,
  subdomainStrategy,
} from '$lib/server/tenancy';
export const resolveTenant = createTenantResolver((event) => {
  const fromSubdomain = subdomainStrategy(event);
  if (fromSubdomain.tenantId) return fromSubdomain;
  return headerStrategy()(event);
});
```

Inside a `+server.ts` or `+page.server.ts` you can read the resolved tenant either from `event.locals.tenantId` (set by the session handler) or — for any tenant-scoped model — just call its collection methods and the global interceptor will filter automatically.

## Creating SMRT Objects

1. Create a new file in `src/lib/objects/`:

```typescript
// src/lib/objects/Product.ts
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
})
@TenantScoped({ mode: 'optional' })
export class Product extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

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

3. Run `npm run dev` - API routes are auto-generated! Because `Product` is `@TenantScoped`, listing via `GET /api/products` will only return rows for the request's tenant. (The generator pluralizes each class's `collection` field; see the "Generated API Routes" table below for the general `/api/{collection}` form.)

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
