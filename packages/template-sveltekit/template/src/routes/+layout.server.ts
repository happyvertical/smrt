/**
 * Root layout server load — builds the AdminShell tenant navigation.
 *
 * The WASD AdminShell (`src/routes/+layout.svelte`) is the default chrome for
 * this app. Its left "tenant" rail is driven by a nav tree derived from the
 * SMRT manifest, and that tree is built HERE — server-side — rather than with a
 * client-side fetch. This mirrors the home page's data pattern
 * (`+page.server.ts`): data is produced during SSR, serialized into the initial
 * HTML, and hydrated on the client with no duplicate request.
 *
 * `tenantNavFromManifest()` is a pure function (data in → data out). It reads
 * the same generated manifest the runtime uses (`.smrt/manifest.json`, written
 * by `smrtPlugin()` and already loaded by `src/lib/server/smrt.ts`), so the nav
 * stays in sync with your `@smrt()` classes automatically instead of being
 * hand-maintained.
 *
 * This load reads no URL/params and declares no `depends()`, so after its
 * initial SSR run SvelteKit does not re-run it on client navigations — only on
 * a full reload or `invalidateAll()`. The manifest-derived nav is therefore
 * effectively static for the session, which is fine (the manifest is fixed at
 * build time). It is independent of each page's own load, so the home page's
 * `depends('smrt:items')` / `invalidate('smrt:items')` refresh flow is
 * untouched by this file.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadManifestFromPathSync } from '@happyvertical/smrt-core/manifest';
import {
  type ShellNavItem,
  type SmrtManifestLike,
  tenantNavFromManifest,
} from '@happyvertical/smrt-svelte/workspace';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => {
  // Same manifest file `src/lib/server/smrt.ts` seeds the registry from. Reading
  // it here returns the parsed object we hand to the pure nav builder; if it is
  // not generated yet (fresh checkout before the first `vite dev`/`vite build`)
  // we fall back to an empty rail rather than failing the whole layout.
  const manifestPath = join(process.cwd(), '.smrt', 'manifest.json');

  let nav: ShellNavItem[] = [];
  if (existsSync(manifestPath)) {
    const manifest = loadManifestFromPathSync(manifestPath);
    if (manifest) {
      // `tenantNavFromManifest` reads a documented subset of the manifest
      // (`SmrtManifestLike`). The core `SmartObjectManifest` carries richer
      // field types (e.g. `ApiConfig` has no index signature), so narrow it to
      // the structural shape the pure helper consumes.
      //
      // `basePath: ''` emits page-style hrefs (`/items`) for the developer to
      // wire to their own list routes. `sectionHints` groups classes by
      // package into readable section titles — extend it as you add packages.
      // `NavSection[]` is structurally a superset of `ShellNavItem[]`, so it
      // feeds straight into <TenantNav items={nav}>.
      nav = tenantNavFromManifest(manifest as unknown as SmrtManifestLike, {
        basePath: '',
        sectionHints: {
          '@happyvertical/smrt-content': 'Content',
          '@happyvertical/smrt-users': 'Users',
        },
      });
    }
  }

  return { nav };
};
