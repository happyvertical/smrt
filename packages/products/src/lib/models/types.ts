/**
 * Shared types for the products package.
 *
 * @packageDocumentation
 */

/**
 * Discriminator for Product STI subtypes.
 *
 * Industry-vertical templates extend `Product` with their own STI subtypes
 * (apparel uses `Style`/`Makeup`; furniture might use `Design`/`Finish`;
 * automotive `Model`/`Trim`) — the upstream package only ships the truly
 * generic primitives:
 *
 * - {@link ProductType.PRODUCT} — plain catalog item (base)
 * - {@link ProductType.MATERIAL} — raw input consumed by manufacturing
 *
 * The axis-declaration concept ("this product varies along `size` with
 * values `[XS, S, M, L, XL]`") is NOT a Product STI subtype — it lives in
 * its own model, {@link ProductVariant}, with a separate table. Per-SKU
 * value pins live on `Sku.attributes` (also in this package — `Sku` was
 * relocated from `@happyvertical/smrt-inventory` to here in Phase 1 so
 * every catalog primitive lives under one roof; inventory only holds
 * stock levels and movements now).
 */
export enum ProductType {
  /** Generic catalog item (default). */
  PRODUCT = 'product',
  /** A raw input — fabric, trim, packaging, etc. — consumed by manufacturing. */
  MATERIAL = 'material',
}

/**
 * High-level classification of a {@link ProductType.MATERIAL} item.
 *
 * Plain string so consumers can extend with vertical-specific kinds without an
 * enum change.
 */
export type MaterialKind =
  | 'fabric'
  | 'trim'
  | 'thread'
  | 'label'
  | 'packaging'
  | 'component'
  | string;
