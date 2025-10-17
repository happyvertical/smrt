/**
 * AssetMetafield model - Defines the controlled vocabulary for metadata keys
 *
 * Lookup table for metadata field definitions with validation rules
 */

import { SmrtObject, smrt } from '@smrt/core';
import type { AssetMetafieldOptions } from './types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetMetafield extends SmrtObject {
  slug = ''; // Primary key (human-readable identifier, e.g., 'width', 'height')
  name = ''; // Display name (e.g., 'Width', 'Height')
  validation = ''; // JSON validation rules stored as text

  constructor(options: AssetMetafieldOptions = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.validation) this.validation = options.validation;
  }

  /**
   * Get validation rules as parsed object
   *
   * @returns Parsed validation object or empty object if no validation
   */
  getValidation(): Record<string, unknown> {
    if (!this.validation) return {};
    try {
      return JSON.parse(this.validation);
    } catch {
      return {};
    }
  }

  /**
   * Set validation rules from object
   *
   * @param rules - Validation rules object
   */
  setValidation(rules: Record<string, unknown>): void {
    this.validation = JSON.stringify(rules);
  }

  /**
   * Get asset metafield by slug
   *
   * @param slug - The slug to search for
   * @returns AssetMetafield instance or null
   */
  static async getBySlug(_slug: string): Promise<AssetMetafield | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
