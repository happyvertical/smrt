/**
 * Asset conventions
 *
 * Shared constants and metadata-key conventions for how apps and agents
 * describe asset relationships and derivation state on top of `smrt-assets`.
 *
 * These are advisory: `AssetAssociation.role` and `Asset` metadata fields
 * accept any string, but standardising on these values makes cross-agent
 * serving, filtering, and UI work possible without everybody inventing
 * their own vocabulary.
 */

/**
 * Canonical association roles used with `AssetAssociation` and noun join
 * tables like `content_assets`.
 *
 * - `source_document`: original upstream document (e.g. agenda PDF) that
 *   later derivatives are extracted from.
 * - `document_image`: page image or other visual derived from a source
 *   document.
 * - `thumbnail`: small preview rendition of another asset.
 * - `asset_variant`: deterministic sized rendition of another asset.
 * - `proof`: non-canonical evidence asset (e.g. a screenshot used to
 *   back a fact).
 * - `derivation_source`: source side of a derivation link (used when a
 *   derivative points back to the asset it was produced from).
 * - `attachment`: generic "this asset belongs to that object" link —
 *   the default for noun join tables.
 * - `hero`: primary/featured asset for an owner.
 */
export const ASSET_ROLES = {
  SOURCE_DOCUMENT: 'source_document',
  DOCUMENT_IMAGE: 'document_image',
  THUMBNAIL: 'thumbnail',
  ASSET_VARIANT: 'asset_variant',
  PROOF: 'proof',
  DERIVATION_SOURCE: 'derivation_source',
  ATTACHMENT: 'attachment',
  HERO: 'hero',
} as const;

export type AssetRole = (typeof ASSET_ROLES)[keyof typeof ASSET_ROLES];

/**
 * Canonical metadata keys used on `Asset.description`-adjacent metadata
 * surfaces or stored via `AssetAssociation` sidecars. These keys are the
 * recommended names for cross-package extraction, provenance, and
 * content-addressing state.
 *
 * Apps are free to add their own keys; using these for the common cases
 * keeps derived-asset tooling portable.
 *
 * - `extractionStatus`: `'pending' | 'running' | 'succeeded' | 'failed'`
 * - `extractionError`: error string from the last extraction attempt
 * - `extractedAt`: ISO timestamp of the last successful extraction
 * - `sourceUrl`: upstream URL the asset was fetched from
 * - `sourceHash`: content-address hash of the source bytes (e.g. sha256)
 * - `pageNumber`: 1-based page number within a multi-page source document
 */
export const ASSET_METADATA_KEYS = {
  EXTRACTION_STATUS: 'extractionStatus',
  EXTRACTION_ERROR: 'extractionError',
  EXTRACTED_AT: 'extractedAt',
  SOURCE_URL: 'sourceUrl',
  SOURCE_HASH: 'sourceHash',
  PAGE_NUMBER: 'pageNumber',
} as const;

export type AssetMetadataKey =
  (typeof ASSET_METADATA_KEYS)[keyof typeof ASSET_METADATA_KEYS];

/**
 * Known extraction status values for `ASSET_METADATA_KEYS.EXTRACTION_STATUS`.
 */
export const ASSET_EXTRACTION_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type AssetExtractionStatus =
  (typeof ASSET_EXTRACTION_STATUS)[keyof typeof ASSET_EXTRACTION_STATUS];
