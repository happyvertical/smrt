/**
 * SMRT System Tables
 *
 * System-level metadata storage for the SMRT framework.
 * All tables use _smrt_ prefix and share the application's database.
 */

// Only export types - schema SQL strings are internal implementation details
export { ensureSystemTables } from './bootstrap.js';
export * from './compatibility.js';
export * from './retention.js';
export * from './types.js';
