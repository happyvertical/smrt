/**
 * Self-registers this package's build-time manifest before any @smrt() decorator
 * in the package fires. Fixes issue #1132: in consumer runtimes (tsx, SvelteKit
 * SSR, plain `vite dev`) the decorator's synchronous manifest lookup previously
 * missed because no step populated the global manifest cache — classes got
 * registered with zero fields and `save()` / `toJSON()` silently dropped every
 * declared property.
 *
 * Import this module as the first statement in `src/index.ts` (and from any
 * other entry that loads class modules — e.g. `src/models/index.ts`,
 * `src/collections/index.ts`) so its top-level side effect runs ahead of any
 * class module's @smrt() decorator.
 *
 * Silent no-op in dev/test, where the vitest plugin already populates manifests
 * via a different path. Only needs to succeed in the published dist output.
 *
 * @see https://github.com/happyvertical/smrt/issues/1132
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';

// `new URL('./manifest.json', import.meta.url)` resolves at runtime to the
// manifest sitting next to this module's compiled output. Vite warns at build
// time that it cannot pre-resolve the URL; that is the intended behavior —
// the URL must resolve to dist/manifest.json at runtime, not be inlined.
ObjectRegistry.registerPackageManifest(
  new URL('./manifest.json', import.meta.url),
);
