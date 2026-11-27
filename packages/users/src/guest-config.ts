/**
 * The app's guest configuration, `permissions.guest` of the `users` package
 * config (#5196).
 *
 * ```ts
 * // smrt.config.ts
 * export default defineConfig({
 *   packages: {
 *     users: {
 *       permissions: {
 *         guest: {
 *           // Collections guests may be granted (`<collection>.read`).
 *           collections: ['products', 'contact_messages'],
 *           // Of those, the ones that also accept guest creates (a contact
 *           // form). Each must also be listed in `collections`.
 *           createCollections: ['contact_messages'],
 *         },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * Absent means no guests. A malformed value (a wrong type, an unknown key, a
 * bad collection name, a create collection that is not also a guest
 * collection) means no guests too: the whole block is refused, never
 * filtered down to the entries that look valid. Guests additionally need
 * PostgreSQL row-level security, enabled tenancy and `TENANT_BASE_DOMAIN`.
 *
 * @packageDocumentation
 */

import { getPackageConfig } from '@happyvertical/smrt-config';
import type { GuestPermissionConfig } from './services/GuestPermissionResolver.js';

const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KNOWN_KEYS = new Set(['collections', 'createCollections']);

function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !COLLECTION_NAME.test(entry)) return null;
    out.push(entry);
  }
  return out;
}

/**
 * Parse a raw `permissions.guest` value. `null` means no guests: the value is
 * absent, empty, or malformed in any way.
 */
export function parseGuestPermissionConfig(
  raw: unknown,
): GuestPermissionConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) return null;
  }
  const record = raw as Record<string, unknown>;
  const collections = names(record.collections);
  if (!collections || collections.length === 0) return null;
  let createCollections: string[] = [];
  if (record.createCollections !== undefined) {
    const parsed = names(record.createCollections);
    if (!parsed) return null;
    const listed = new Set(collections);
    if (!parsed.every((name) => listed.has(name))) return null;
    createCollections = parsed;
  }
  return {
    collections: [...new Set(collections)],
    createCollections: [...new Set(createCollections)],
  };
}

/** The app's guest configuration from the `users` package config, or `null`. */
export function getGuestPermissionConfig(): GuestPermissionConfig | null {
  try {
    const config = getPackageConfig<{
      permissions?: { guest?: unknown };
    }>('users', {});
    return parseGuestPermissionConfig(config.permissions?.guest);
  } catch {
    return null;
  }
}
