/**
 * Manifest pre-registration for source-mode (tsx) demo servers (#1756).
 *
 * Must be imported BEFORE any model module: the @smrt() decorator reads the
 * package manifest cache synchronously at class-decoration time, so the
 * manifest has to be registered ahead of the first model import. In built
 * outputs the inlined `__smrt-register__` shim does this; under tsx there is
 * no build step, so this module performs the same side effect from the
 * manifest JSON on disk (built by `pnpm build`, or `.smrt/` from any dev run).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectRegistry } from '@happyvertical/smrt-core';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const candidates = [
  join(packageRoot, '.smrt', 'manifest.json'),
  join(packageRoot, 'dist', 'lib', 'manifest.json'),
  join(packageRoot, 'dist', 'manifest.json'),
];

let registered = false;
for (const candidate of candidates) {
  try {
    const manifest = JSON.parse(readFileSync(candidate, 'utf-8'));
    ObjectRegistry.registerPackageManifest(manifest);
    registered = true;
    break;
  } catch {
    // try next candidate
  }
}

if (!registered) {
  throw new Error(
    '[demo] No package manifest found (checked .smrt/ and dist/). Run `pnpm build` in packages/products first.',
  );
}
