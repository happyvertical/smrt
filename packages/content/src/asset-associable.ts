import type { Asset } from '@happyvertical/smrt-assets';

/**
 * Contract for objects that participate in the content/asset association
 * pattern.
 *
 * Any class that exposes asset-relationship methods (e.g. `Content` and its
 * STI subclasses) implements this interface explicitly so consumers can rely
 * on the methods existing instead of falling back to `typeof === 'function'`
 * duck-typing checks.
 *
 * @example
 * ```ts
 * import type { AssetAssociable } from '@happyvertical/smrt-content';
 *
 * async function attachThumbnail(
 *   target: AssetAssociable,
 *   image: Asset,
 * ): Promise<void> {
 *   // No defensive runtime checks needed — the contract guarantees the method.
 *   await target.addAsset(image, 'thumbnail', 0);
 * }
 * ```
 */
export interface AssetAssociable {
  /**
   * Get all assets associated with this object.
   *
   * @param relationship - Optional filter by relationship type
   *   (e.g. `'thumbnail'`, `'attachment'`).
   * @returns Array of associated assets. Returns an empty array if the object
   *   has not been persisted yet.
   */
  getAssets(relationship?: string): Promise<Asset[]>;

  /**
   * Associate an asset with this object via a typed relationship.
   *
   * @param asset - The asset to associate. Must be persisted (have an `id`).
   * @param relationship - Relationship type. Must match
   *   `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. Defaults to `'attachment'`.
   * @param sortOrder - Non-negative integer for display order.
   * @throws if either side is unsaved or the relationship/sort order is invalid.
   */
  addAsset(
    asset: Asset,
    relationship?: string,
    sortOrder?: number,
  ): Promise<void>;

  /**
   * Remove an associated asset.
   *
   * @param assetId - The asset ID to detach.
   * @param relationship - Optional specific relationship to remove. If omitted,
   *   all relationships between this object and the asset are removed.
   */
  removeAsset(assetId: string, relationship?: string): Promise<void>;
}

/**
 * Contract for objects exposing typed access to a `metadata` JSON field.
 *
 * Use alongside an explicit interface (such as {@link AssetAssociable}) to
 * give consumers a stable contract for reading/writing the loose JSON bag,
 * without leaking the `metadata: Record<string, any>` type into call sites.
 */
export interface MetadataAccessor<
  TMetadata extends Record<string, any> = Record<string, any>,
> {
  /**
   * Get the full metadata record. Always returns an object (never `null`).
   * The returned reference is the live object — callers should treat it as
   * read-only and use {@link MetadataAccessor.setMetadata} or
   * {@link MetadataAccessor.updateMetadata} to mutate it safely.
   */
  getMetadata(): TMetadata;

  /**
   * Replace the entire metadata record.
   *
   * @param metadata - The new metadata object. `null`/`undefined` clears it.
   */
  setMetadata(metadata: TMetadata | null | undefined): void;

  /**
   * Shallow-merge the supplied patch over the existing metadata.
   *
   * @param patch - Partial metadata. Keys present in the patch overwrite the
   *   existing record; keys absent from the patch are preserved.
   * @returns The merged metadata record.
   */
  updateMetadata(patch: Partial<TMetadata>): TMetadata;
}
