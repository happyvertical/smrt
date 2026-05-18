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
 * - {@link ProductType.VARIANT} — axis-value variant grouping (above SKU)
 * - {@link ProductType.MATERIAL} — raw input consumed by manufacturing
 */
export enum ProductType {
  /** Generic catalog item (default). */
  PRODUCT = 'product',
  /** Concrete variant grouping (e.g. a colorway). */
  VARIANT = 'variant',
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
