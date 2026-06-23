/**
 * ImageCollection - Collection manager for Image instances
 *
 * Provides image-specific query operations, tenant-aware queries, and bulk operations
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { Image } from './image';

/**
 * Qualified STI discriminator for Image rows in the shared `assets` table.
 *
 * Raw SQL on this tenant-scoped collection must scope by `_meta_type` so it
 * never returns sibling Asset subclasses. The orientation/resolution helpers
 * below compare two columns (e.g. `width > height`), which `list()`'s
 * value-based WHERE clause cannot express — so they either filter in-memory
 * after a tenant-/STI-scoped `list()` (mirroring `ImageSearch.search()`) or,
 * for the global-image lookups (`findGlobal`/`findWithGlobals`), run raw SQL
 * with `{ allowRawOnTenantScoped: true }` after manually injecting both the
 * tenant predicate and this `_meta_type`. A literal `tenant_id IS NULL` filter
 * can't go through `list()` either — the interceptor rejects an explicit null
 * tenant filter as an isolation violation.
 */
const IMAGE_META_TYPE = '@happyvertical/smrt-images:Image';

export class ImageCollection extends SmrtCollection<Image> {
  static readonly _itemClass = Image;

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant-Aware Query Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all images belonging to a specific tenant
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of images belonging to this tenant
   */
  async findByTenant(tenantId: string): Promise<Image[]> {
    return (await this.list({ where: { tenantId } })) as Image[];
  }

  /**
   * Find all global images (images without a tenant)
   *
   * @returns Array of global images
   */
  async findGlobal(): Promise<Image[]> {
    // `list({ where: { tenantId: null } })` throws under an active tenant
    // context: the interceptor flags an explicit null tenant filter as an
    // isolation violation (it cannot tell "give me shared rows" from "give me
    // another tenant's rows"). Raw SQL with the bypass flag — manually scoped
    // to the Image STI discriminator and `tenant_id IS NULL` — returns global
    // images under any context, mirroring `findWithGlobals`. (#1407)
    return (await this.query(
      `SELECT * FROM ${this.tableName}
       WHERE _meta_type = ?
         AND tenant_id IS NULL`,
      [IMAGE_META_TYPE],
      { allowRawOnTenantScoped: true },
    )) as Image[];
  }

  /**
   * Find images belonging to a tenant plus all global images
   *
   * @param tenantId - The tenant ID to include
   * @returns Array of tenant-specific and global images
   */
  async findWithGlobals(tenantId: string): Promise<Image[]> {
    // Intentionally cross-tenant: returns the given tenant's images plus all
    // global (tenant-less) images. `list()` would let the interceptor inject
    // `tenant_id = <currentContext>` and strip the globals, so this stays raw —
    // but we manually scope to the Image STI discriminator and pass the bypass
    // flag since tenant filtering is handled by the explicit predicate here.
    //
    // The raw bypass disables the interceptor's isolation guard, so replicate
    // it: `findByTenant`/`list()` throw when asked for another tenant's rows
    // under an active context, and this must too — otherwise a caller could
    // read another tenant's images by passing an arbitrary `tenantId` (e.g.
    // straight from untrusted params). A system / super-admin-bypass context
    // (no enforced tenant) keeps the deliberate cross-tenant capability for
    // admin callers. (#1400 fail-closed)
    const tenantContext = getCurrentTenant();
    if (
      tenantContext &&
      !isSuperAdminBypass() &&
      tenantContext.tenantId !== tenantId
    ) {
      throw new TenantIsolationError(
        `Tenant isolation violation in Image.findWithGlobals: context tenant ` +
          `is '${tenantContext.tenantId}' but query requested '${tenantId}'`,
        { tenantId: tenantContext.tenantId, attemptedTenantId: tenantId },
      );
    }
    return (await this.query(
      `SELECT * FROM ${this.tableName}
       WHERE _meta_type = ?
         AND (tenant_id = ? OR tenant_id IS NULL)`,
      [IMAGE_META_TYPE, tenantId],
      { allowRawOnTenantScoped: true },
    )) as Image[];
  }

  /**
   * Get images by minimum dimensions
   *
   * @param minWidth - Minimum width in pixels
   * @param minHeight - Minimum height in pixels
   * @returns Array of images meeting minimum dimension requirements
   */
  async getByMinDimensions(
    minWidth: number,
    minHeight: number,
  ): Promise<Image[]> {
    return (await this.list({
      where: {
        'width >=': minWidth,
        'height >=': minHeight,
      },
    })) as Image[];
  }

  /**
   * Get images by maximum dimensions
   *
   * @param maxWidth - Maximum width in pixels
   * @param maxHeight - Maximum height in pixels
   * @returns Array of images within maximum dimension limits
   */
  async getByMaxDimensions(
    maxWidth: number,
    maxHeight: number,
  ): Promise<Image[]> {
    return (await this.list({
      where: {
        'width <=': maxWidth,
        'height <=': maxHeight,
      },
    })) as Image[];
  }

  /**
   * Get landscape images (width > height)
   *
   * @returns Array of landscape-oriented images
   */
  async getLandscape(): Promise<Image[]> {
    // `width > height` is a column-to-column comparison `list()`'s WHERE can't
    // express, so list (tenant- + STI-scoped) then filter in-memory via the
    // `isLandscape` computed property — same pattern as ImageSearch.search().
    const all = (await this.list({})) as Image[];
    return all.filter((image) => image.isLandscape);
  }

  /**
   * Get portrait images (height > width)
   *
   * @returns Array of portrait-oriented images
   */
  async getPortrait(): Promise<Image[]> {
    // Column-to-column (`height > width`): list (tenant-/STI-scoped) then
    // filter in-memory via the `isPortrait` computed property.
    const all = (await this.list({})) as Image[];
    return all.filter((image) => image.isPortrait);
  }

  /**
   * Get square images (width === height)
   *
   * @returns Array of square images
   */
  async getSquare(): Promise<Image[]> {
    // Column-to-column (`width = height AND width > 0`): list (tenant-/STI-
    // scoped) then filter in-memory. `isSquare` already encodes the `width > 0`
    // guard, so zero-dimension placeholders are excluded.
    const all = (await this.list({})) as Image[];
    return all.filter((image) => image.isSquare);
  }

  /**
   * Get images missing alt text
   *
   * @returns Array of images without accessibility text
   */
  async getMissingAltText(): Promise<Image[]> {
    return (await this.list({
      where: { alt: '' },
    })) as Image[];
  }

  /**
   * Get high resolution images (4K+)
   *
   * @returns Array of high resolution images
   */
  async getHighResolution(): Promise<Image[]> {
    // `width >= 3840 OR height >= 2160` needs an OR across two columns, which
    // `list()`'s AND-only WHERE can't express. List (tenant-/STI-scoped) then
    // filter in-memory via the `isHighResolution()` helper.
    const all = (await this.list({})) as Image[];
    return all.filter((image) => image.isHighResolution());
  }

  /**
   * Get images by aspect ratio range
   *
   * @param minRatio - Minimum aspect ratio (width/height)
   * @param maxRatio - Maximum aspect ratio (width/height)
   * @returns Array of images within the aspect ratio range
   */
  async getByAspectRatio(minRatio: number, maxRatio: number): Promise<Image[]> {
    // The aspect-ratio predicate is computed from two columns, which `list()`'s
    // WHERE can't express. List (tenant-/STI-scoped) then filter in-memory via
    // the `aspectRatio` computed property. `aspectRatio` returns 0 when height
    // is 0, so the `height > 0` guard preserves the original semantics for any
    // sensible positive ratio range.
    const all = (await this.list({})) as Image[];
    return all.filter(
      (image) =>
        image.height > 0 &&
        image.aspectRatio >= minRatio &&
        image.aspectRatio <= maxRatio,
    );
  }
}
