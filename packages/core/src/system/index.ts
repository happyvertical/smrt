/**
 * SMRT System Tables
 *
 * System-level metadata storage for the SMRT framework.
 * All tables use _smrt_ prefix and share the application's database.
 */

// The browser-safe subset lives in `./browser.js` (#2838); the registry
// snapshot needs `node:path` and stays Node-only. The public runtime helpers
// and types are exported; schema DDL stays internal.
export * from './browser.js';
export * from './registry-snapshot.js';
