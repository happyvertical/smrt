# @happyvertical/smrt-products

Product catalog — reference template for triple-consumption: npm package library, module federation, and standalone REST API server.

## Models

- **Product**: STI base. Tenant-scoped (`@TenantScoped({ mode: 'optional' })`, nullable `tenantId`). Knowledge base product with specs, tags, and the `productType` discriminator. Consumers subclass this with vertical-specific subtypes (apparel `Style`, automotive `Model`, furniture `Design`, etc.).
- **ProductVariant**: STI subtype. An axis-value variant of a Product (colorway, finish, length...). Meta fields: `parentProductId`, `axisValues` (JSON map). Generic — works for any vertical where one catalog item varies along discrete axes.
- **Material**: STI subtype. Raw input consumed by manufacturing (fabric, trim, thread, packaging, component). Meta fields: `materialKind`, `uom`, `costPerUnit`. Materials are first-class products in the catalog — the SAP/NetSuite pattern. Bills of materials in `@happyvertical/smrt-manufacturing` reference Materials by id.
- **ProductAsset**: dedicated owned-asset join in `product_assets` with `relationship` and `sortOrder`. Tenant-scoped to match Product.
- **Category**: hierarchical (parentId, level, productCount). STI base, tenant-scoped.

## Vertical-specific subtypes

This package deliberately ships ONLY the generic primitives. Domain-specific top-level item types live in the consumer's template:

- Apparel: `Style extends Product`, `Makeup extends Product`
- Furniture: `Design extends Product`, `Configuration extends Product`
- Automotive: `Model extends Product`, `Trim extends Product`
- CPG: `Brand extends Product`, `Recipe extends Product`

Each is a small subclass: `@smrt()`, override `productType`, add `@meta()` fields. See `packages/template-apparel-erp` for a worked example.

## Collections

- **ProductCollection** — base. Polymorphic queries return the correct subclass instance per row.
- **ProductVariantCollection** / **MaterialCollection** — STI-filtered subclasses. Override `_itemClass`; framework auto-filters by `_meta_type`.
- **CategoryCollection** — standard Category CRUD with `getRootCategories()`.
- **ProductAssetCollection** — direct access to `product_assets` rows and product asset helper wrappers.

## Multi-tenancy

Optional. With `withTenant(id, fn)` (from `@happyvertical/smrt-tenancy`), all queries auto-filter and inserts auto-stamp `tenantId`. Without it, models behave globally (`tenantId = null`). This lets the same package serve both shared reference catalogs and per-merchant SaaS catalogs.

## Triple-Consumption Pattern

Same codebase consumed three ways:
1. **NPM library**: import classes directly
2. **Module federation**: runtime component sharing (experimental)
3. **Standalone API**: `startRestServer([Product, Category])`

## Virtual Modules (Vite)

Auto-generated via Vite plugins: `@happyvertical/smrt-client` (TypeScript client), `@happyvertical/smrt-types`, `@happyvertical/smrt-routes` (Express), `@happyvertical/smrt-mcp`, `@happyvertical/smrt-manifest`.

Svelte 5 stores use runes (`$state`, `$derived`, `$effect`). Separate `product-store.server.svelte.ts` vs `product-store.client.svelte.ts` for SSR safety.

## Gotchas

- **`npm run build` now emits the published library surface directly**: package consumers read model, collection, and helper exports from `dist/lib`
- **Use `npm run build:all` only when you need standalone or federation bundles** in addition to the library output
- **Constructor must explicitly assign all properties**: `Object.assign` doesn't work reliably with decorators
- **STI subtype-specific fields use `@meta()`** — they live in `_meta_data` JSON, not as columns on `products`. Override `productType` on each subclass.
- **Module Federation marked experimental**: may change
