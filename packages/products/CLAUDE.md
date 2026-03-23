# @happyvertical/smrt-products

Product catalog — reference template for triple-consumption: npm package library, module federation, and standalone REST API server.

## Models

- **Product**: STI enabled. Knowledge base product with specs, tags.
- **ProductAsset**: dedicated owned-asset join in `product_assets` with `relationship` and `sortOrder`.
- **Category**: hierarchical (parentId, level, productCount). STI enabled.

## Collections

- **ProductCollection**: CRUD plus `findByManufacturer()`, `findInStock()`, and `getAssets()` / `addAsset()` / `removeAsset()`.
- **ProductAssetCollection**: direct access to `product_assets` rows and product asset helper wrappers.

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
- **Module Federation marked experimental**: may change
