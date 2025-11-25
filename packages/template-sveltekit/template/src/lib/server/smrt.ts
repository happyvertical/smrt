/**
 * Centralized SMRT Configuration
 *
 * This file provides configuration for all SMRT objects in your project.
 * Import this file in your routes to get properly configured collections.
 */

import { ObjectRegistry, type SmrtClassOptions } from '@happyvertical/smrt-core';

// Import all SMRT objects to register them
import '../objects/index.js';

/**
 * Per-object configuration overrides
 *
 * Use this to configure specific objects differently from defaults.
 * Example:
 *   AuditLog: { db: { url: process.env.AUDIT_DB_URL!, type: 'postgres' } }
 */
const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {
  // Add object-specific overrides here
};

/**
 * Get default configuration for SMRT objects
 */
function getDefaultConfig(): SmrtClassOptions {
  return {
    db: {
      url: process.env.DATABASE_URL || './data/app.db',
      type: (process.env.DATABASE_TYPE as 'sqlite' | 'postgres') || 'sqlite',
    },
    ai: process.env.OPENAI_API_KEY
      ? {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY,
        }
      : undefined,
  };
}

/**
 * Get configuration for a specific SMRT class
 */
export function getSmrtConfig(className: string): SmrtClassOptions {
  const defaults = getDefaultConfig();
  const override = objectOverrides[className];
  return override ? { ...defaults, ...override } : defaults;
}

/**
 * Get a collection instance for a SMRT class
 *
 * Usage in routes:
 *   const products = await getCollection<Product>('Product');
 *   const items = await products.list();
 */
export async function getCollection<T>(className: string) {
  return await ObjectRegistry.getCollection<T>(className, getSmrtConfig(className));
}
