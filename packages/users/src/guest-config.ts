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
 *           // The body fields a guest may set on each create collection.
 *           // Protected, system and sensitive fields are rejected.
 *           createFields: {
 *             contact_messages: { allowedFields: ['name', 'email', 'message'] },
 *           },
 *           // Run-time models (hosted user-app models) are excluded unless
 *           // named here by qualified name (`package:Class`). Listing one
 *           // opens nothing else: it must still be in `collections`, pass
 *           // every other ceiling rule and have a generated policy target.
 *           runtimeModels: ['app_1:ContactMessage'],
 *           // Reverse-proxy hops to trust for the client address (default 0).
 *           trustedProxyHops: 1,
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
const KNOWN_KEYS = new Set([
  'collections',
  'createCollections',
  'createFields',
  'trustedProxyHops',
  'rateLimits',
  'runtimeModels',
]);
/** A qualified model name: `package:Class`, no whitespace, bounded. */
const QUALIFIED_MODEL = /^[^\s:]{1,200}:[^\s:]{1,200}$/;

function parseRuntimeModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !QUALIFIED_MODEL.test(entry)) return null;
    out.push(entry);
  }
  return [...new Set(out)];
}
const FIELD_KEYS = new Set([
  'allowedFields',
  'maxBodyBytes',
  'maxStringLength',
]);
const LIMIT_KEYS = new Set([
  'windowMs',
  'createPerClient',
  'createPerTenant',
  'readPerClient',
  'readPerTenant',
]);
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function parseCreateFields(
  raw: unknown,
  createCollections: readonly string[],
): GuestPermissionConfig['createFields'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: NonNullable<GuestPermissionConfig['createFields']> = {};
  const listed = new Set(createCollections);
  for (const [collection, entry] of Object.entries(raw)) {
    // Only a create collection may carry a field list.
    if (!listed.has(collection)) return null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    for (const key of Object.keys(entry)) {
      if (!FIELD_KEYS.has(key)) return null;
    }
    const { allowedFields, maxBodyBytes, maxStringLength } = entry as Record<
      string,
      unknown
    >;
    if (
      !Array.isArray(allowedFields) ||
      allowedFields.length === 0 ||
      !allowedFields.every(
        (name) => typeof name === 'string' && FIELD_NAME.test(name),
      )
    ) {
      return null;
    }
    if (maxBodyBytes !== undefined && !positiveInt(maxBodyBytes)) return null;
    if (maxStringLength !== undefined && !positiveInt(maxStringLength)) {
      return null;
    }
    out[collection] = {
      allowedFields: [...allowedFields] as string[],
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      ...(maxStringLength === undefined ? {} : { maxStringLength }),
    };
  }
  return out;
}

function parseRateLimits(
  raw: unknown,
): GuestPermissionConfig['rateLimits'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LIMIT_KEYS.has(key) || !positiveInt(value)) return null;
    out[key] = value;
  }
  return out;
}

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
  let createFields: GuestPermissionConfig['createFields'];
  if (record.createFields !== undefined) {
    const parsed = parseCreateFields(record.createFields, createCollections);
    if (!parsed) return null;
    createFields = parsed;
  }
  // A create collection must say which fields a guest may set: without a
  // field list there is no create to allow, so the block is refused whole.
  if (
    createCollections.length > 0 &&
    !createCollections.every(
      (name) => createFields && Object.hasOwn(createFields, name),
    )
  ) {
    return null;
  }
  let trustedProxyHops: number | boolean | undefined;
  if (record.trustedProxyHops !== undefined) {
    const hops = record.trustedProxyHops;
    if (
      typeof hops !== 'boolean' &&
      !(Number.isSafeInteger(hops) && (hops as number) >= 0)
    ) {
      return null;
    }
    trustedProxyHops = hops as number | boolean;
  }
  let rateLimits: GuestPermissionConfig['rateLimits'];
  if (record.rateLimits !== undefined) {
    const parsed = parseRateLimits(record.rateLimits);
    if (!parsed) return null;
    rateLimits = parsed;
  }
  let runtimeModels: string[] | undefined;
  if (record.runtimeModels !== undefined) {
    const parsed = parseRuntimeModels(record.runtimeModels);
    if (!parsed) return null;
    runtimeModels = parsed;
  }
  return {
    collections: [...new Set(collections)],
    createCollections: [...new Set(createCollections)],
    ...(runtimeModels ? { runtimeModels } : {}),
    ...(createFields ? { createFields } : {}),
    ...(trustedProxyHops === undefined ? {} : { trustedProxyHops }),
    ...(rateLimits ? { rateLimits } : {}),
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
