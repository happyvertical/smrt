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

// During library builds, smrtPlugin replaces this entire module with generated
// code that embeds the scanned manifest inline (#1506/#1507) — published dists
// never resolve this URL, so downstream bundlers cannot break registration by
// relocating the compiled module away from dist/manifest.json. The runtime
// lookup below is the fallback for source-mode runs without that transform.
ObjectRegistry.registerPackageManifest(
  new URL('./manifest.json', import.meta.url),
);
