/**
 * AdFormat model - Standard IAB ad dimensions and types
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { AdFormatType } from '../types/index.js';

/**
 * AdFormat defines standard ad dimensions and types (IAB standards).
 *
 * @example
 * ```typescript
 * const leaderboard = await formats.create({
 *   name: 'Leaderboard',
 *   width: 728,
 *   height: 90,
 *   formatType: AdFormatType.BANNER
 * });
 * ```
 */
// Intentional exception to standards.md §7 (`@TenantScoped`):
// `AdFormat` is a shared catalog model describing IAB standard ad dimensions
// (e.g. 728x90 Leaderboard). The dimensions are an industry standard, not a
// per-tenant configuration. Adding `@TenantScoped` would require every tenant
// to seed the same IAB rows. See `packages/ads/CLAUDE.md` "Tenancy" section
// for context.
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AdFormat extends SmrtObject {
  /**
   * Display name (e.g., "Leaderboard", "Medium Rectangle")
   */
  name: string = '';

  /**
   * Width in pixels
   */
  width: number = 0;

  /**
   * Height in pixels
   */
  height: number = 0;

  /**
   * Format type (banner, native, video)
   */
  formatType: AdFormatType = AdFormatType.BANNER;

  /**
   * Optional description
   */
  description: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.width !== undefined) this.width = options.width;
    if (options.height !== undefined) this.height = options.height;
    if (options.formatType !== undefined) this.formatType = options.formatType;
    if (options.description !== undefined)
      this.description = options.description;
  }

  /**
   * Get dimensions as string (e.g., "728x90")
   */
  getDimensions(): string {
    return `${this.width}x${this.height}`;
  }

  /**
   * Check if format matches specific dimensions
   */
  matchesDimensions(width: number, height: number): boolean {
    return this.width === width && this.height === height;
  }
}

export default AdFormat;
