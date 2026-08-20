/**
 * SMRT System Tables
 *
 * System-level metadata storage for the SMRT framework.
 * All tables use _smrt_ prefix and share the application's database.
 */

// Export the public runtime helpers and types; schema SQL stays internal.
export { ensureSystemTables } from './bootstrap.js';
export * from './compatibility.js';
export * from './retention.js';
export * from './types.js';
