/**
 * Barrel file for migrations module
 * This file exists because vite's getCoreEntries() expects src/migrations.ts
 * when the package.json export is ./dist/migrations.js
 */

export * from './migrations/index.js';
