/**
 * Browser-safe subset of the system-table surface (#2838).
 *
 * Everything `system/index.ts` exports except the registry snapshot, which
 * sanitizes filesystem paths with `node:path` and exists for the Node-side
 * dev plane (smrt-dev-mcp). `browser.ts` re-exports this module so a page
 * bundle never reaches `node:path`; `system/index.ts` re-exports it too, so
 * the Node entry's surface is unchanged.
 */

// `SMRT_SCHEMA_VERSION` is the one schema.ts value consumers legitimately
// need outside this package — e.g. to assert against the version
// `ensureSystemTables()` stamps into `_smrt_migrations` — without hardcoding
// a literal that goes stale on every bump (#3080).
export { ensureSystemTables } from './bootstrap.js';
export * from './compatibility.js';
export * from './diagnostics.js';
export * from './retention.js';
export { SMRT_SCHEMA_VERSION } from './schema.js';
export * from './types.js';
