/**
 * SMRT System Tables
 *
 * System-level metadata storage for the SMRT framework.
 * All tables use _smrt_ prefix and share the application's database.
 */

// Export the public runtime helpers and types; schema DDL stays internal.
// `SMRT_SCHEMA_VERSION` is the one schema.ts value consumers legitimately
// need outside this package — e.g. to assert against the version
// `ensureSystemTables()` stamps into `_smrt_migrations` — without hardcoding
// a literal that goes stale on every bump (#3080).
export { ensureSystemTables } from './bootstrap.js';
export * from './compatibility.js';
export * from './diagnostics.js';
export * from './registry-snapshot.js';
export * from './retention.js';
export { SMRT_SCHEMA_VERSION } from './schema.js';
export * from './types.js';
