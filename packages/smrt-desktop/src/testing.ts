/**
 * Source of the `@happyvertical/smrt-desktop/testing` entry. The workspace
 * source aliasing in `@happyvertical/smrt-vitest` maps `dist/testing.js` to
 * `src/testing.ts`, so the public subpath needs this file; the reference
 * server and test doubles live in `./reference` so their types ship (the
 * private fixtures under `./testing/` are excluded from the declarations).
 */
export * from './reference/index.js';
