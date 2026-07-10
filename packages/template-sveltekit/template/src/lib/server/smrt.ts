/**
 * Centralized SMRT Configuration
 *
 * This file provides configuration for all SMRT objects in your project.
 * Import this file in your routes to get properly configured collections.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ObjectRegistry,
  type SmrtClassOptions,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { loadManifestFromPathSync } from '@happyvertical/smrt-core/manifest';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';

// Import all SMRT objects to register them.
import '../objects/index.js';

// Upgrade those registrations to package-qualified identities
// (`<package>:<Class>`) — required to link each class to its scanned field
// metadata below. smrtPlugin() generates this module on every dev/build run
// (it is gitignored, like the generated API routes); guard the import so a
// fresh checkout that has not run the plugin yet still boots.
try {
  await import('./smrt-register.js');
} catch (error) {
  // Not generated yet — the first `vite dev` / `vite build` creates it. Do
  // not hide a real import/runtime error from an existing generated module.
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : '';
  if (
    code !== 'ERR_MODULE_NOT_FOUND' &&
    !message.includes('smrt-register.js')
  ) {
    throw error;
  }
}

// Hydrate field metadata for this app's own objects from the local manifest
// written by smrtPlugin() (`.smrt/manifest.json`). The decorator import above
// registers the classes, but their scanned field metadata (plain properties
// like `title: string = ''`) lives in the manifest — without seeding it, the
// runtime only knows the framework base fields and server-side writes would
// silently drop your domain columns.
const localManifestPath = join(process.cwd(), '.smrt', 'manifest.json');
if (existsSync(localManifestPath)) {
  loadManifestFromPathSync(localManifestPath);
}

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
      url: process.env.DATABASE_URL || './app.db',
      type: (process.env.DATABASE_TYPE as 'sqlite' | 'postgres') || 'sqlite',
    },
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
export async function getCollection<T extends SmrtObject>(className: string) {
  const config = getSmrtConfig(className);
  const objectOverride = objectOverrides[className];
  const requestScopedDb = objectOverride?.db
    ? undefined
    : (getRequestScopedDatabase() as SmrtClassOptions['db'] | undefined);

  return await ObjectRegistry.getCollection<T>(className, {
    ...config,
    db: requestScopedDb ?? config.db,
  });
}
