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

Svelte 5 stores use runes (`$state`, `$derived`, `$effect`). `product-store.svelte.ts` is the main store (backed by the SMRT client); `product-store.client.svelte.ts` is a virtual-module-free variant for federation builds.

## Schema migrations (Phase 1 release)

This package's schema changed shape between the previous release and the Phase 1 apparel-ERP release. Consumers upgrading need to migrate two tables.

### `Sku` rows moved tables

Previously `Sku` shipped in `@happyvertical/smrt-inventory` under table `inventory_skus`. It now lives here under `product_skus`. Cross-package refs (`StockLevel.skuId`, `BomLine.componentSkuId`) carry plain string ids that still resolve.

**Upgrade procedure** (works on SQLite + Postgres; does NOT rely on `CREATE TABLE AS` which strips constraints):

1. **Boot the new version once** so the framework's lazy `syncSchema` creates `product_skus` with the right PRIMARY KEY, NOT NULL, UNIQUE (`code`, `tenant_id`), and indexes derived from the `Sku` model.

2. **Idempotently copy rows**:

   ```sql
   BEGIN;
   INSERT INTO product_skus (
     id, slug, context, created_at, updated_at,
     tenant_id, product_id, code, barcode, name,
     attributes, weight_grams, parent_sku_id, active
   )
   SELECT
     id, slug, context, created_at, updated_at,
     tenant_id, product_id, code, barcode, name,
     attributes, weight_grams, parent_sku_id, active
   FROM inventory_skus
   WHERE NOT EXISTS (
     SELECT 1 FROM product_skus p WHERE p.id = inventory_skus.id
   );
   COMMIT;
   ```

3. **Drop the legacy table** once row counts match:

   ```sql
   DROP TABLE IF EXISTS inventory_skus;
   ```

### `ProductVariant` changed shape entirely

Previously a Product STI subtype carrying `parentProductId` + `axisValues` JSON inside `_meta_data` on the shared `products` table (`_meta_type='@happyvertical/smrt-products:ProductVariant'`). It is now a **standalone model** on its own `product_variants` table, with columns `productId`, `axisName`, `allowedValues`, `label`, `sortOrder`.

**There is no automatic data conversion.** The old "catalog grouping above SKU" concept doesn't map 1:1 to the new "per-axis declaration" concept. Recommended procedure:

1. Inspect the old rows: `SELECT * FROM products WHERE _meta_type = '@happyvertical/smrt-products:ProductVariant';`. Treat them as historical reference.
2. Re-author axis declarations against the new shape (one `ProductVariant` row per `(productId, axisName)` pair, with `allowedValues` listing the values).
3. Once the new declarations are populated and verified, remove the legacy rows: `DELETE FROM products WHERE _meta_type = '@happyvertical/smrt-products:ProductVariant';`.

If you had per-colorway / per-variant images attached via `ProductAsset` rows pointing at old ProductVariant ids, repoint those to the parent Product id; group-by-axis-value queries on `Sku.attributes` cover the same use case at the SKU level.

## Gotchas

- **`ProductVariant` and `Sku` are NOT Product STI subtypes** — they each have their own table (`product_variants`, `product_skus`) because their shapes don't fit the Product schema. Don't try to query them via `ProductCollection`.
- **`npm run build` emits the published library surface directly**: package consumers read model, collection, and helper exports from `dist/lib`. Cross-package imports from this package should target `/models` or `/collections` subpaths (not the main entry) when the consumer isn't a vite app — the main entry pulls in vite virtual modules.
- **Use `npm run build:all` only when you need standalone or federation bundles** in addition to the library output
- **Constructor must explicitly assign all properties**: `Object.assign` doesn't work reliably with decorators
- **STI subtype-specific fields use `Meta<T>`** — declare them as `fieldName: Meta<FieldType> = defaultValue`. The AST scanner detects the `Meta<T>` type wrapper at build time and routes the field through `_meta_data` JSON storage instead of materializing it as a column on the parent's table. Do **NOT** use the runtime `@meta()` decorator on STI children — it never reaches the manifest, so the schema generator treats the field as an ordinary column on the parent table and the framework's hydration path can't tell it's meta. Override `productType` on each subclass.
- **Tenant-scoped STI children must repeat `@TenantScoped`** — `@TenantScoped` registers per concrete className, so `Material extends Product` inheriting from a tenant-scoped `Product` is NOT automatically tenant-scoped itself. `MaterialCollection.list/save` passes `'Material'` to the tenant interceptor, which looks up `'Material'` (not `'Product'`) in the per-class registry. Without an explicit `@TenantScoped({ mode: 'optional' })` on `Material`, material rows skip the tenant auto-filter and auto-populate.
- **STI children must repeat `@smrt({ api, mcp, cli })` generation config (S5 #1406)** — like `@TenantScoped`, the generation config is registered per concrete className and is NOT inherited from the STI parent. An empty `@smrt()` on a child resolves `getConfig(child).api/.mcp` to `undefined`, which the REST and MCP generators treat as "expose EVERYTHING" — including `delete` and write-capable MCP tools — even when the parent deliberately restricts its surface. The package's `mcp.ts` generator enumerates the whole registry, so an under-configured child ships a wide-open surface silently. Re-declare the parent's `api`/`mcp`/`cli` posture on every subtype (see `Material`). Consumer subtypes (apparel `Style`/`Makeup`, automotive `Model`/`Trim`, …) must do the same.
- **Two-tenant same-slug is currently a hard error** for tenant-scoped STI bases (`Product`, `Category`). The core schema generator hardcodes the STI unique index as `(slug, context, _meta_type)` and does NOT include `tenant_id` even for `@TenantScoped` classes. Two tenants saving a row with the same slug + context + meta_type collide at the SQL layer. Workaround: namespace slugs per tenant on the application side (e.g. `${tenantId}-widget`) until the upstream framework fix lands.
- **Module Federation marked experimental**: may change
