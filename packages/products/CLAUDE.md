# @happyvertical/smrt-products

Product catalog — reference template for triple-consumption: npm package library, module federation, and standalone REST API server.

## Models

- **Product**: STI base. Tenant-scoped (`@TenantScoped({ mode: 'optional' })`, nullable `tenantId`). Knowledge base product with specs, tags, and the `productType` discriminator. Consumers subclass this with vertical-specific subtypes (apparel `Style`, automotive `Model`, furniture `Design`, etc.).
- **Material**: STI subtype. Raw input consumed by manufacturing (fabric, trim, thread, packaging, component). Meta fields: `materialKind`, `uom`, `costPerUnit`. Materials are first-class products in the catalog — the SAP/NetSuite pattern. Bills of materials in `@happyvertical/smrt-manufacturing` reference Materials by id.
- **ProductVariant**: standalone (NOT a Product STI subtype). Declarative axis definition: `productId`, `axisName` (e.g. `'size'`, `'color'`, `'finish'`), `allowedValues` (JSON-stored array), optional `label` and `sortOrder`. Per-SKU value pins live on `Sku.attributes`. Lives in its own `product_variants` table; `conflictColumns: ['product_id', 'axis_name', 'tenant_id']`.
- **Sku**: standalone. The smallest sellable / countable unit. `productId` points at a `Product` or any of its STI subtypes; `code` is the human-meaningful identifier; `attributes` JSON pins each axis value (`{ size: 'M', color: 'navy' }`). Lives in its own `product_skus` table; `conflictColumns: ['code', 'tenant_id']`. Stock balance and movement history for a Sku live in `@happyvertical/smrt-inventory`.
- **ProductAsset**: dedicated owned-asset join in `product_assets` with `relationship` and `sortOrder`. Tenant-scoped to match Product.
- **Category**: hierarchical (parentId, level, productCount). STI base, tenant-scoped.

## Vertical-specific Product subtypes

This package deliberately ships ONLY the generic primitives. Domain-specific top-level item types live in the consumer's template:

- Apparel: `Style extends Product`, `Makeup extends Product`
- Furniture: `Design extends Product`, `Configuration extends Product`
- Automotive: `Model extends Product`, `Trim extends Product`
- CPG: `Brand extends Product`, `Recipe extends Product`

Each is a small subclass: `@smrt()`, override `productType`, add `@meta()` fields. See `packages/template-apparel-erp` for a worked example.

## Variants — the two concepts

The framework's variant story uses two distinct primitives that look similar but do different jobs:

- **`ProductVariant`** — *axis declaration*. "For product X, axis `size` accepts the values `[XS, S, M, L, XL]`." Drives form/UI choices.
- **`Sku.attributes`** — *per-unit value pins*. `{ color: 'navy', size: 'M' }` on each concrete sellable SKU.

Both live in this package — all catalog shapes are here. Stock motion (where the SKU is, how many, history) lives in `@happyvertical/smrt-inventory`.

There is deliberately no separate "catalog grouping above SKU" row (a la a "Navy colorway" row sitting between the Product and its Skus). Group SKUs by axis value via `attributes.color = 'navy'` queries; attach per-axis-value assets via `ProductAsset` rows with relationship metadata. Matches how Shopify, Stripe Products, and most e-commerce platforms model the same shape.

## Collections

- **ProductCollection** — base. Polymorphic queries return the correct subclass instance per row.
- **MaterialCollection** — STI-filtered subclass. Override `_itemClass`; framework auto-filters by `_meta_type`.
- **ProductVariantCollection** — standalone collection over `product_variants`. Helpers: `findForProduct(productId)`, `findAxis(productId, axisName)`.
- **SkuCollection** — standalone collection over `product_skus`. Helpers: `findByCode`, `findByBarcode`, `findByProduct`, `findByParent`, `findActive`.
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

## Schema migrations (Phase 1 release)

This package's schema changed shape between the previous release and the Phase 1 apparel-ERP release. Consumers upgrading need to migrate two tables:

- **`Sku` rows moved tables.** Previously `Sku` shipped in `@happyvertical/smrt-inventory` under table `inventory_skus`. It now lives here under `product_skus`. **Upgrade SQL**: `CREATE TABLE product_skus AS SELECT * FROM inventory_skus;` then `DROP TABLE inventory_skus;`. Cross-package refs (`StockLevel.skuId`, `BomLine.componentSkuId`) carry plain string ids that still resolve.
- **`ProductVariant` changed shape entirely.** Previously it was a Product STI subtype carrying `parentProductId` + `axisValues` JSON, stored as rows in the shared `products` table with `_meta_type='@happyvertical/smrt-products:ProductVariant'`. It is now a standalone model on its own `product_variants` table, with columns `productId`, `axisName`, `allowedValues`, `label`, `sortOrder`. **There is no automatic data conversion** — the old grouping concept no longer maps 1:1 to the new axis-declaration concept. Consumers that had ProductVariant rows should treat them as historical and re-author axis declarations against the new shape.

## Gotchas

- **`ProductVariant` and `Sku` are NOT Product STI subtypes** — they each have their own table (`product_variants`, `product_skus`) because their shapes don't fit the Product schema. Don't try to query them via `ProductCollection`.
- **`npm run build` emits the published library surface directly**: package consumers read model, collection, and helper exports from `dist/lib`. Cross-package imports from this package should target `/models` or `/collections` subpaths (not the main entry) when the consumer isn't a vite app — the main entry pulls in vite virtual modules.
- **Use `npm run build:all` only when you need standalone or federation bundles** in addition to the library output
- **Constructor must explicitly assign all properties**: `Object.assign` doesn't work reliably with decorators
- **STI subtype-specific fields use `@meta()`** — they live in `_meta_data` JSON, not as columns on `products`. Override `productType` on each subclass.
- **Module Federation marked experimental**: may change
